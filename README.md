# Voice Cooking Assistant

A real-time voice-first cooking assistant web app. Brainstorm meals, generate grocery lists, and get hands-free live guidance while you cook — all powered by Gemini AI.

## Features

- **What to Cook** — conversational meal brainstorming based on what you have, your mood, or dietary needs
- **Grocery List** — generate a categorized shopping list for any recipe instantly
- **Live Cooking Mode** — step-by-step guidance, instant Q&A, and a countdown timer — all hands-free

Voice in, voice out. Short answers. No walls of text while your pan is on the stove.

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/Mashrafi27/Voice-Cooking.git
cd Voice-Cooking
```

### 2. Create a conda environment

```bash
conda create -n voice-cooking python=3.11 -y
conda activate voice-cooking
pip install -r requirements.txt
```

### 3. Add your Gemini API key

```bash
cp .env.example .env
```

Edit `.env` and add your key:

```
GOOGLE_API_KEY=your_key_here
```

Get a free API key at [Google AI Studio](https://aistudio.google.com/apikey).

### 4. Run

```bash
python app.py
```

Open **http://localhost:5001** in your browser.

## Tech Stack

- **Backend:** Flask, Flask-SocketIO
- **AI:** Google Gemini 2.0 Flash (`google-genai`)
- **Frontend:** Vanilla JS, Web Speech API (voice input + TTS output)
