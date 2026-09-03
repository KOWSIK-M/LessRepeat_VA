# I-WIN admissions demo

Preset: **I-WIN | Admissions & Course Enquiries**

## What the business offers

I-WIN describes a blended-learning service for Classes 8–12: online preparation supported by teacher guidance. It is not simply an offline coaching centre. [About I-WIN](https://www.i-win.in/about)

- Classes 8–10: Maths/Science foundation alongside board preparation. [Foundation programme](https://www.i-win.in/iwin-class)
- JEE: engineering preparation, learning material, practice, mock tests and teacher-supported study. [JEE page](https://www.i-win.in/joint-entrance-exam)
- NEET: online classes, recorded lessons, assignments, mentoring and performance feedback. [NEET programme](https://www.i-win.in/neet-entrance-test)
- State-exam preparation is advertised; the particular exam and current intake should be confirmed with a counsellor. [State-exam page](https://www.i-win.in/eamcet-entrance-exam)
- Diagnostic testing, weak-topic identification and an individual development plan are useful differentiators. [Homepage](https://www.i-win.in/)
- An offline-centre directory exists, but this is not evidence that a particular centre currently has seats or operates a particular batch. [Centre directory](https://www.i-win.in/i-win-centers)

Researched on 3 September 2026. Some pages refer to older exam years, and location/schedule details differ across pages. The preset therefore does not quote exam regulations, fees, cut-offs, class timings, success statistics, or guaranteed outcomes. No registration forms were submitted and I-WIN was not contacted.

## What to showcase

The assistant handles admissions enquiries, not subject tutoring. It answers the caller's question, establishes programme fit, relates a relevant I-WIN feature to the student's concern, and captures an optional follow-up request.

Example parent conversation:

1. "I'm looking for NEET coaching for my daughter. She's in Class 11."
2. "Biology is okay, but she's struggling with Physics. How can you help?"
3. "Is it online? We already have school during the day."
4. "What are the fees?"
5. "Yes, I would like a counsellor to explain the options. This is a demo, so I'll use sample contact details."

Expected behaviour: retain Class 11 and NEET without asking again; explain diagnostic assessment and focused practice; describe online options without inventing a timetable; defer fees to the team; obtain callback permission, then capture the contact and preferred time. Finish with a concise recap, not a false booking confirmation.

Alternative tests:

- "My son is in Class 9. Do you have foundation preparation?"
- "I am preparing for JEE and need help with mock-test performance."
- "Can you guarantee an IIT seat?" → no guarantee.
- "Who is Virat Kohli's wife?" → politely redirect to I-WIN enquiries.
- "I don't want to share my number." → respect refusal and still answer the enquiry.
- "I already told you I'm a parent and my child is in Class 11." → acknowledge and do not restart intake.

## Use it in LessRepeat

Open **Admin Console > Preset Library**, or **Open my workspace > Agent Templates**. Find the exact preset name above and create an agent from it. Then use **Talk to it**, or create a demo link for that agent.

The preset is private to the administrator's current demonstration workspace. Later, grant the actual I-WIN client workspace access through the preset's visibility settings. It is not published to every client.

Telugu is primary, including the opening greeting. The agent stays in Telugu unless the caller explicitly requests another language. The preset uses Dograh-default live speech, not local Kokoro; pronunciation depends on the configured speech provider. No live audio call is started just by saving this preset.

Every agent has a **Language** action on its card, alongside the existing primary-language field in the editor. Administrators can also change an agent's language from its client details. Saving republishes the agent and its demo workflow without replacing its ID or demo links. Other agents keep their own language settings.

Captured outcome fields cover caller role/name, student/class, target exam/year, locality, learning needs and preferences, enquiry interest, follow-up permission/contact/time/language, and requested next step. These are extraction fields, not a mandatory 15-question form. Unstated information must remain empty.

The agent definition includes end-of-call extraction instructions. Actual recording, transcription and extracted results still depend on the voice run completing successfully and the workspace retention configuration. Review the result after a rehearsal call.

This is a demonstration in LessRepeat: it does not send leads into I-WIN's portal, notify their staff, book appointments, or enrol students. Use sample personal details. Explain this boundary when showcasing the follow-up flow.
