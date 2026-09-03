# Multilingual calls

An agent's primary language selects its opening, not a permanent language lock. During the same call, the caller can ask for Hindi, Telugu, English or another language and later switch back. The agent instructions preserve the enquiry, previous answers, corrections and business boundaries. An isolated borrowed word does not trigger a switch.

The Language action offers the same ten languages as the agent editor. Review the greeting after changing it; language detection for a stored greeting is script-based and cannot distinguish every language sharing a script (for example Hindi and Marathi).

## Speech support is provider-dependent

Live conversations use Dograh speech; local Kokoro and Rumik remain available for voice previews. An explicitly enabled Gemini Live deployment retains its operator-selected configuration. The current Dograh organization uses its default voice and multilingual (`multi`) transcription. This is not a guarantee that every language is recognized or pronounced correctly. The LLM's language abilities do not expand the speech providers' supported language sets.

Deepgram documents multilingual code-switching and model-specific language lists: [code-switching](https://developers.deepgram.com/docs/multilingual-code-switching), [models and languages](https://developers.deepgram.com/docs/models-languages-overview/). Single-language support does not necessarily mean a language is supported in multilingual auto-detection mode. Do not promise universal language support or native accents without a recorded rehearsal on the actual deployed provider.

## Captured details

Extraction is enabled on opening, conversation and closing nodes so ordinary hangups can extract from the current node during Dograh's finalization. It reads the complete mixed-language history, keeps business field keys unchanged, retains names in their original script and uses explicit corrections. The recording UI normalizes native-script phone digits to 0–9 without guessing missing digits. False and zero values are retained.

Extraction is model-based, not guaranteed real-time storage of every word. Provider failures, unclear transcription, process crashes or failed finalization can still leave missing results. These changes do not reconstruct older calls automatically. Enabling extraction at node transitions can add small post-processing model costs.

## Rehearsal

Use synthetic contact details. Give a name and course in English, request Hindi, correct a contact number, request Telugu, then request English again. Verify the assistant does not restart intake. End once normally and once by hanging up mid-conversation; check Calls & Recordings for the same field keys, original name, corrected number and explicit consent. Never claim a booking is confirmed without the relevant booking integration succeeding.
