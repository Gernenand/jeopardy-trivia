# Jeopardy! Real-Time Multiplayer Trivia App (Node.js + Express + Socket.io)

A complete real-time multiplayer Jeopardy-style trivia application featuring three dedicated views:
- **`/host` (`public/host.html`)**: Private Host Dashboard showing question prompts **and secret correct answers**, buzzer controls, player moderation (`✕ Kick`), round switchers, and the unified JSON editor.
- **`/screen` (`public/screen.html`)**: Non-spoiler Audience/TV Projector Display showing the fullscreen Jeopardy board, active clue prompts (never answers), first-buzz spotlight & countdown timer, Final Jeopardy display, and persistent live scoreboard.
- **`/play` or `/` (`public/index.html`)**: Mobile Player Buzzer & Final Jeopardy wager/response interface.

## Run Locally & Deploy to Render / Glitch

1. **Install dependencies**: `npm install express socket.io`
2. **Start server**: `node server.js`
3. **Open the Views**:
   - **Private Host Dashboard**: `http://localhost:3000/host`
   - **TV / Projector Display**: `http://localhost:3000/screen`
   - **Player Mobile Buzzer**: `http://localhost:3000/play` (or `/`)
