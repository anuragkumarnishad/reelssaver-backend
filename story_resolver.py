#!/usr/bin/env python3
"""Resolve an active Instagram Story using a persistent instagrapi session.
Outputs one JSON object to stdout. Intended to be called only by the local Node backend.
"""
import json
import os
import re
import sys
from pathlib import Path


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    raise SystemExit(code)


def main():
    if len(sys.argv) < 2:
        fail("Story URL is required")
    story_url = sys.argv[1].strip()
    match = re.search(r"instagram\.com/stories/([^/?#]+)(?:/([0-9]+))?", story_url, re.I)
    if not match or match.group(1).lower() == "highlights":
        fail("A valid active Story URL or Story profile URL is required")
    target_username, target_id = match.group(1), match.group(2) or None

    username = os.getenv("IG_STORY_USERNAME", "").strip()
    password = os.getenv("IG_STORY_PASSWORD", "")
    session_id = os.getenv("IG_STORY_SESSIONID", "").strip()
    if not session_id:
        cookie_header = os.getenv("IG_COOKIE", "")
        session_match = re.search(r"(?:^|;\s*)sessionid=([^;]+)", cookie_header)
        session_id = session_match.group(1).strip() if session_match else ""
    verification_code = os.getenv("IG_STORY_VERIFICATION_CODE", "").strip() or None
    if not session_id and (not username or not password):
        fail("Configure IG_STORY_SESSIONID or IG_STORY_USERNAME and IG_STORY_PASSWORD")

    try:
        from instagrapi import Client
    except Exception:
        fail("Python dependency missing. Run: pip install -r requirements-story.txt")

    session_path = Path(os.getenv("IG_STORY_SESSION_FILE", str(Path(__file__).with_name("story-session.json"))))
    client = Client()
    try:
        session_path.parent.mkdir(parents=True, exist_ok=True)
        if session_path.exists():
            client.load_settings(session_path)
        else:
            # Persist the generated device identity before the first login so a
            # manual Instagram checkpoint can be retried from the same device.
            client.dump_settings(session_path)
        if session_id:
            client.login_by_sessionid(session_id)
        else:
            client.login(username, password, verification_code=verification_code)
        client.dump_settings(session_path)

        user_id = client.user_id_from_username(target_username)
        stories = client.user_stories(user_id)
        selected = stories
        if target_id:
            selected = [item for item in stories if str(item.pk) == target_id or str(item.id).startswith(target_id + "_")]
            if not selected:
                fail("The exact Story was not found. It may be expired or inaccessible.")
        if not selected:
            fail("This profile has no active Stories available to the configured account.")

        def serialize(story):
            is_video = int(getattr(story, "media_type", 1) or 1) == 2
            video_url = str(getattr(story, "video_url", "") or "")
            image_url = str(getattr(story, "thumbnail_url", "") or "")
            media_url = video_url if is_video else image_url
            if not media_url:
                return None
            return {
                "id": str(story.pk),
                "type": "video" if is_video else "photo",
                "url": media_url,
                "thumbnailUrl": image_url or None,
                "width": getattr(story, "original_width", None) or 0,
                "height": getattr(story, "original_height", None) or 0,
                "duration": float(getattr(story, "video_duration", 0) or 0)
            }

        items = [item for item in (serialize(story) for story in selected) if item]
        if not items:
            fail("Instagram returned Stories without downloadable media URLs")
        user = getattr(selected[0], "user", None)
        owner = getattr(user, "username", None) or target_username
        metadata = {"username": owner, "caption": "Instagram Story", "likes": 0, "comments": 0}
        result = ({"kind": "single", **items[0], "metadata": metadata} if len(items) == 1
                  else {"kind": "picker", "items": items, "metadata": metadata})
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except SystemExit:
        raise
    except Exception as exc:
        try:
            session_path.parent.mkdir(parents=True, exist_ok=True)
            client.dump_settings(session_path)
        except Exception:
            pass
        fail(f"Instagram Story session error: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
