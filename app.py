import os
from google import genai
from google.genai import types
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "voice-cooking-secret-key-2024")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY")

SYSTEM_PROMPTS = {
    "brainstorm": (
        "You are a friendly cooking brainstorm assistant. Ask what they have, their mood, dietary needs. "
        "Suggest 2-3 meal ideas concisely. Keep responses under 50 words."
    ),
    "grocery": (
        "You are a grocery list generator. Given a recipe name, output ONLY a clean bulleted grocery list "
        "grouped by category (Produce, Protein, Pantry, etc.). No intro text. Be precise with quantities."
    ),
    "cooking": (
        "You are a hands-free live cooking assistant. The user is cooking RIGHT NOW. "
        "Give ONLY the immediate next step or answer. Max 15 words per response. "
        "If asked a measurement: just say the measurement. "
        "If asked about heat: just say the heat level. "
        "Be a sous chef, not a lecturer. Use TTS-friendly language (no markdown)."
    ),
}

# Per-session state stored in a dict keyed by socket session ID
sessions = {}


def get_session(sid):
    if sid not in sessions:
        sessions[sid] = {
            "mode": "brainstorm",
            "recipe": None,
            "context": [],
        }
    return sessions[sid]


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect")
def handle_connect():
    sid = request.sid
    get_session(sid)
    emit("connected", {"sid": sid})


@socketio.on("disconnect")
def handle_disconnect():
    sid = request.sid
    sessions.pop(sid, None)


@socketio.on("set_mode")
def handle_set_mode(data):
    sid = request.sid
    session = get_session(sid)
    mode = data.get("mode", "brainstorm")
    if mode in SYSTEM_PROMPTS:
        session["mode"] = mode
    emit("mode_set", {"mode": session["mode"]})


@socketio.on("set_recipe")
def handle_set_recipe(data):
    sid = request.sid
    session = get_session(sid)
    session["recipe"] = data.get("recipe", "")
    emit("recipe_set", {"recipe": session["recipe"]})


@socketio.on("message")
def handle_message(data):
    sid = request.sid
    session = get_session(sid)

    user_text = data.get("text", "").strip()
    mode = data.get("mode", session["mode"])
    client_context = data.get("context", [])

    if not user_text:
        emit("error", {"message": "No text provided."})
        return

    if not GOOGLE_API_KEY:
        emit("error", {"message": "GOOGLE_API_KEY is not set on the server."})
        return

    # Build message history — prefer client-sent context (last 6), fall back to server session
    history = client_context[-6:] if client_context else session["context"][-6:]

    # If in grocery or cooking mode and a recipe is set, prepend recipe context
    system_prompt = SYSTEM_PROMPTS.get(mode, SYSTEM_PROMPTS["brainstorm"])
    if session.get("recipe") and mode in ("grocery", "cooking"):
        system_prompt = f"Current recipe: {session['recipe']}.\n\n{system_prompt}"

    # Build contents list in google-genai format
    contents = []
    for msg in history:
        role = "model" if msg.get("role") == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": msg.get("content", "")}]})
    contents.append({"role": "user", "parts": [{"text": user_text}]})

    full_response = ""
    try:
        client = genai.Client(api_key=GOOGLE_API_KEY)
        response_stream = client.models.generate_content_stream(
            model="gemini-2.0-flash",
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                max_output_tokens=512,
            ),
        )

        for chunk in response_stream:
            text_chunk = chunk.text
            if text_chunk:
                full_response += text_chunk
                socketio.emit("token", {"token": text_chunk}, to=sid)

        # Store the completed exchange in server-side session context
        new_context = list(history) + [
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": full_response},
        ]
        session["context"] = new_context[-12:]

        socketio.emit("done", {"response": full_response}, to=sid)

    except Exception as exc:
        err = str(exc)
        if "API_KEY_INVALID" in err or "api key" in err.lower():
            socketio.emit("error", {"message": "Invalid API key. Check your GOOGLE_API_KEY."}, to=sid)
        elif "quota" in err.lower() or "rate" in err.lower():
            socketio.emit("error", {"message": "Rate limit reached. Please wait a moment."}, to=sid)
        else:
            socketio.emit("error", {"message": f"Error: {err}"}, to=sid)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    debug = os.environ.get("FLASK_DEBUG", "true").lower() == "true"
    print(f"Starting Voice Cooking Assistant on http://localhost:{port}")
    socketio.run(app, host="0.0.0.0", port=port, debug=debug)
