# Verification — 2026-10-08

- `npm test`: 11 passing Node tests; API responses injected, no paid calls.
- Browser: rapid edits ignore obsolete results and coalesce the next request; reset cannot restore an old result; a single eligible option gets 100; model exclusions remain separate from manual exclusions; removed suggestions are remembered; final evaluation receives the last transcript after `session.closed`. Six checks passed with simulated API/voice events.
- Topic: required, trimmed and limited to 160 characters; included in Responses, Decisions and Live context. The browser enables voice after a topic and two options are entered; reset clears the topic. Topic-only input produces no scores or paid requests.
- Real OpenAI: the English example returned scores from Decisions and English reasons and a suggested alternative from Responses. The scores summed to 100.
- Real GPT-Live, before the English translation: WebRTC connected, recognized a synthetic Russian utterance, delegated comparison, produced speech and closed with `session.closed`. The resulting comparison favored staying home for a quiet evening in heavy rain. These checks used generated audio, never the user's microphone.
- Earlier layout checks: no horizontal overflow at 375, 768 or 1440 pixels; buttons have at least 44-pixel targets; keyboard focus and reduced motion are supported. No browser console errors in the original real API scenario.
- English browser check: title and document language updated; controls, example and model replies are in English. No visible Cyrillic or horizontal overflow at the current 843-pixel viewport. Start over clears the example and disables Talk until a topic and two options are entered. README preview updated.

The interface and server prompts are now in English; the Live unit test checks that voice instructions require English. The live voice check above used Russian test audio. An English spoken session has not yet been verified end to end.

These are smoke checks, not a model-quality benchmark. Natural microphone conversations, interruptions and mobile Safari still need hands-on checks. API model access was verified for the local key, not for other accounts. No recordings, keys or private conversations are included in this repository.
