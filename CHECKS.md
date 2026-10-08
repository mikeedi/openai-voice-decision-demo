# Verification — 2026-10-08

- `npm test`: 10 passing Node tests; API responses injected, no paid calls.
- Browser: rapid edits ignore obsolete results and coalesce the next request; reset cannot restore an old result; a single eligible option gets 100; model exclusions remain separate from manual exclusions; removed suggestions are remembered; final evaluation receives the last transcript after `session.closed`. Six checks passed with simulated API/voice events.
- Real OpenAI: Decisions and Responses returned successful responses; full text comparisons worked with the configured key.
- Real GPT-Live: WebRTC connected, recognized a synthetic Russian utterance, delegated comparison, produced speech and closed with `session.closed`. The resulting comparison favored staying home for a quiet evening in heavy rain. These checks used generated audio, never the user's microphone.
- Layout: initial desktop screen fits 1280×720; no horizontal overflow at 375, 768 or 1440 pixels; buttons have at least 44-pixel targets; keyboard focus and reduced motion are supported. No browser console errors in the real API scenario.

These are smoke checks, not a model-quality benchmark. Natural microphone conversations, interruptions and mobile Safari still need hands-on checks. API model access was verified for the local key, not for other accounts. No recordings, keys or private conversations are included in this repository.
