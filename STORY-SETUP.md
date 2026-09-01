# Self-hosted Instagram Story resolver (Windows)

This uses a local Python `instagrapi` worker instead of a paid Story API. Use a dedicated Instagram account, not your main account.

## 1. Install

Open Command Prompt in the backend folder:

```bat
npm install
python -m pip install -r requirements-story.txt
```

If `python` is not recognized, install Python 3.11+ and enable “Add Python to PATH”, or use `py -m pip install -r requirements-story.txt`.

## 2. Configure `.env`

```env
IG_STORY_USERNAME=dedicated_account_username
IG_STORY_PASSWORD=dedicated_account_password
IG_STORY_VERIFICATION_CODE=
IG_STORY_SESSION_FILE=./story-session.json
STORY_PYTHON_COMMAND=python
```

If your Windows Python command is `py`, set `STORY_PYTHON_COMMAND=py`.

## 3. Start

```bat
npm start
```

Paste an active Story URL in the website. On the first request, Python logs in and creates `story-session.json`. Later requests reuse that device session.

If Instagram asks for 2FA, temporarily put the current code in `IG_STORY_VERIFICATION_CODE`, resolve once, then remove the code from `.env` after `story-session.json` is created.

## Security

- Never publish `.env` or `story-session.json`.
- Do not paste credentials or session data into chat.
- Use only content you own or have permission to download.
- Unofficial automated access can trigger rate limits, verification challenges, or account restrictions; use a dedicated account and keep request volume low.
