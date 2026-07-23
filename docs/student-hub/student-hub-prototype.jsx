import { useState, useRef, useEffect } from "react";

/* ------------------------------------------------------------------ */
/*  Design tokens — "law library" palette, casebook serif, transcript  */
/* ------------------------------------------------------------------ */
const T = {
  paper: "#FAF8F2",
  ink: "#1C1B17",
  green: "#1F4D3A",
  greenDark: "#153728",
  oxblood: "#7A2E2E",
  brass: "#A98B45",
  rule: "#D9D4C7",
  faint: "#6E6A5E",
  serif: "'Iowan Old Style','Palatino Linotype','Book Antiqua',Georgia,serif",
  sans: "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "'SF Mono',Consolas,'Liberation Mono',Menlo,monospace",
};

/* ------------------------------------------------------------------ */
/*  Case text (OCR'd from the student's own scanned casebook)          */
/* ------------------------------------------------------------------ */
const CASE_TEXT = `HAWKINS v. McGEE, Supreme Court of New Hampshire, 1929. 84 N.H. 114, 146 A. 641.
Assumpsit against a surgeon for breach of an alleged warranty of the success of an operation (removal of scar tissue from plaintiff's burned right palm and grafting of skin from his chest). Jury verdict of $3,000 for plaintiff on the warranty count; a negligence count was nonsuited. Trial court ordered the verdict set aside as excessive unless plaintiff remitted all above $500; plaintiff refused.
BRANCH, J.: Statements that the boy would be in the hospital "three or four days, not over four," and back to work "a few days" later, were mere opinions or predictions and impose no contractual liability. But the statement "I will guarantee to make the hand a hundred per cent perfect hand or a hundred per cent good hand," if uttered, would establish a warranty. Whether words could possibly bear the contractual meaning imputed to them is a preliminary question of law, but the trial court did not err in submitting the contract question to the jury: there was evidence the defendant repeatedly solicited the operation, and plaintiff's counsel advanced the theory that he wished to "experiment on skin grafting," in which he had little experience — supporting the inference that the words were intended at face value as an inducement to consent.
Damages: the jury charge allowed recovery for (1) pain and suffering from the operation and (2) ill effects of the operation on the hand. This was error. Contract damages are "compensation for a breach, measured in the terms of the contract"; the purpose is "to put the plaintiff in as good a position as he would have been in had the defendant kept his contract" (Williston). The case is analogous to a machine warranted to do certain work: damages are the difference between the value of the machine as warranted and its actual value, plus incidental losses within the parties' contemplation. The true measure here is the difference between the value to him of a perfect or good hand, as promised, and the value of his hand in its present condition, plus incidental consequences fairly within the contemplation of the parties. Pain incident to the operation was part of the consideration the plaintiff gave — part of the price paid for a good hand — and furnishes no test of the difference in value. Worsening of the hand is not a separate element; it is subsumed in the true rule, and damages could be assessed for failure to improve the hand even absent worsening. Defendant's requested instructions (including that both parties must have "understood" a guarantee) were properly denied: the standard is external, not internal; mental reservations are immaterial where the promise was made and relied on. New trial.
NOTE: On the eve of the new trial McGee paid Hawkins $1,400 and settled. McGee's suit against his liability insurer failed: the policy covered "malpractice, error, or mistake," not the "special contract." McGee v. United States Fidelity & Guaranty Co., 53 F.2d 953 (1st Cir. 1931). The complaint had alleged three months' hospitalization and that the grafted tissue became matted and hair-growing, leaving the hand practically useless where before it had been practical and useful.
SULLIVAN v. O'CONNOR, 363 Mass. 579, 296 N.E.2d 183 (1973): surgeon promised to enhance a professional entertainer's appearance by nose surgery; three operations left it worse. Jury instructions embraced a reliance measure — out-of-pocket expenses plus worsening of condition plus pain and suffering of the unnecessary third operation — and the court upheld them, doubting whether the expectancy (value of the promised nose) should be available in such cases, while noting plaintiff waived any claim to it.
CONTEXT (Fuller & Perdue, The Reliance Interest in Contract Damages): three protectable interests — restitution (disgorge value conferred on defendant), reliance (restore plaintiff's position before the promise), expectation (give plaintiff the value of the promised performance). Restitution presents the strongest claim to judicial intervention (defendant gained what plaintiff lost); expectation, though the default measure, arguably presents the least impressive claim.`;

const PROFESSOR_PROMPT = `Context: you are helping a first-year law student prepare for a Contracts class on the material below, which the student scanned from their own casebook. Default to Socratic questioning, as their professor would. But follow the student's lead: if they say they don't understand something, shift into explanation and work it through with them iteratively until it's solid, then pick the questioning back up. The goal is that they walk into class genuinely prepared. Here is the reading:\n\n${CASE_TEXT}`;

/* ------------------------------------------------------------------ */
/*  Static study content (generated from the same scan)                */
/* ------------------------------------------------------------------ */
const BRIEF = [
  ["Citation", "Hawkins v. McGee, 84 N.H. 114, 146 A. 641 (1929) (Branch, J.) — the \u201chairy hand\u201d case."],
  ["Facts", "Surgeon solicited the chance to graft skin from the plaintiff\u2019s chest onto his burn-scarred palm, telling him and his father: \u201cI will guarantee to make the hand a hundred per cent perfect hand.\u201d The operation left the hand worse — matted, restricted, practically useless. Jury awarded $3,000 on a warranty count; the trial court ordered remittitur to $500."],
  ["Issue 1 — Formation", "Can a surgeon\u2019s pre-operative assurances constitute an enforceable warranty?"],
  ["Holding 1", "Yes, if a reasonable person would take them at face value. Predictions (\u201cthree or four days in the hospital\u201d) are opinion, not contract. But the \u201chundred per cent\u201d guarantee, made while soliciting the operation — possibly to experiment with skin grafting — could reasonably be understood as an inducement meant to be binding. Objective standard: the speaker\u2019s mental reservations are immaterial."],
  ["Issue 2 — Damages", "What is the measure of damages for breach of a warranty of cure?"],
  ["Holding 2", "Expectation. The purpose of contract damages is to put the plaintiff where performance would have left him: value of the hand as promised minus value of the hand as delivered, plus foreseeable incidentals. Analogy: breach of warranty on a machine."],
  ["Key move", "Pain and suffering is NOT recoverable — the pain of the operation was part of the price Hawkins paid, i.e., his consideration, not his damages. Worsening is not a separate element; it is folded into the value differential, and recovery would lie even with no worsening at all (failure to improve)."],
  ["Disposition", "New trial. (Settled on its eve for $1,400; McGee\u2019s malpractice insurer successfully denied coverage — the policy covered mistakes, not special contracts.)"],
  ["Pair with", "Sullivan v. O\u2019Connor (Mass. 1973): botched nose surgery; court upheld a RELIANCE measure (expenses + worsening + pain of the unnecessary third operation), doubting expectancy should apply to doctors\u2019 promises at all. The two cases frame the expectation-vs-reliance debate."],
];

const OUTLINE = [
  { h: "I. The three interests (Fuller & Perdue)", items: [
    "Restitution — disgorge what D gained from P. Strongest claim: D\u2019s gain mirrors P\u2019s loss.",
    "Reliance — restore P to his pre-promise position (out-of-pocket).",
    "Expectation — give P the value of the promised performance. The default rule, yet arguably the \u201cleast impressive\u201d claim to judicial protection. Why protect it? (Class theme.)",
  ]},
  { h: "II. Hawkins v. McGee — expectation applied", items: [
    "Formation: objective theory. Prediction \u2260 promise; guarantee + solicitation + experiment motive \u2192 jury question.",
    "Measure: value as warranted \u2212 value as delivered (+ foreseeable incidentals).",
    "Pain excluded: it was consideration, not loss. Elegant and brutal.",
    "No worsening required: failure to improve alone breaches the warranty.",
  ]},
  { h: "III. Sullivan v. O\u2019Connor — the reliance compromise", items: [
    "Reliance measure upheld for physician promises: expenses + worsening + pain of operations beyond those bargained for.",
    "Policy: patients over-read optimism; doctors would practice defensively; expectancy of a \u201cperfect nose\u201d is speculative.",
    "Exam frame: Hawkins gives the rule, Sullivan gives the counter-pressure. Know when each measure over- or under-compensates.",
  ]},
  { h: "IV. Anticipate the hypos", items: [
    "Hand not worse, merely unimproved — recovery under Hawkins? (Yes: value differential survives.)",
    "Should the pain of the operation count if a SECOND, corrective operation is needed? (Sullivan says yes for the extra one.)",
    "Insurance kicker: McGee\u2019s carrier walked — why special contracts fall outside malpractice cover.",
  ]},
];

/* ------------------------------------------------------------------ */
/*  Components                                                         */
/* ------------------------------------------------------------------ */
function Tab({ id, label, active, onClick }) {
  return (
    <button
      onClick={() => onClick(id)}
      style={{
        appearance: "none", border: "none", cursor: "pointer",
        background: active ? T.green : "transparent",
        color: active ? T.paper : T.green,
        fontFamily: T.sans, fontSize: 13, fontWeight: 600,
        letterSpacing: "0.06em", textTransform: "uppercase",
        padding: "10px 18px", borderRadius: 2,
        borderBottom: active ? `2px solid ${T.brass}` : "2px solid transparent",
        transition: "background 120ms ease",
      }}
    >
      {label}
    </button>
  );
}

function BriefView() {
  return (
    <div>
      {BRIEF.map(([k, v], i) => (
        <div key={i} style={{ display: "flex", gap: 16, padding: "14px 0", borderBottom: `1px solid ${T.rule}`, flexWrap: "wrap" }}>
          <div style={{ flex: "0 0 150px", fontFamily: T.sans, fontSize: 12, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: T.oxblood, paddingTop: 2 }}>{k}</div>
          <div style={{ flex: "1 1 300px", fontFamily: T.serif, fontSize: 15.5, lineHeight: 1.55, color: T.ink }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function OutlineView() {
  return (
    <div>
      {OUTLINE.map((sec, i) => (
        <div key={i} style={{ marginBottom: 26 }}>
          <div style={{ fontFamily: T.serif, fontSize: 18, fontWeight: 700, color: T.green, marginBottom: 10 }}>{sec.h}</div>
          {sec.items.map((it, j) => (
            <div key={j} style={{ display: "flex", gap: 10, padding: "5px 0 5px 8px" }}>
              <div style={{ color: T.brass, fontFamily: T.serif }}>&sect;</div>
              <div style={{ fontFamily: T.serif, fontSize: 15, lineHeight: 1.55, color: T.ink }}>{it}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* Transcript-style Socratic mode — with voice */
function SocraticView() {
  const [history, setHistory] = useState([]);   // {role, content}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [started, setStarted] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const endRef = useRef(null);
  const recRef = useRef(null);
  const voiceRef = useRef(null);

  const SR = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  const TTS = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [history, busy]);

  /* Pick a professorial voice once the browser loads its voice list */
  useEffect(() => {
    if (!TTS) return;
    const pick = () => {
      const vs = window.speechSynthesis.getVoices();
      voiceRef.current =
        vs.find(v => /Daniel|Arthur|George|en-GB/i.test(v.name + v.lang)) ||
        vs.find(v => v.lang && v.lang.startsWith("en")) || vs[0] || null;
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
    return () => { window.speechSynthesis.onvoiceschanged = null; };
  }, [TTS]);

  function speak(text) {
    if (!TTS || !voiceOn) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voiceRef.current) u.voice = voiceRef.current;
    u.rate = 0.98; u.pitch = 0.9;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
  }

  function stopSpeaking() { if (TTS) { window.speechSynthesis.cancel(); setSpeaking(false); } }

  function toggleListen() {
    if (!SR) return;
    if (listening) { recRef.current?.stop(); return; }
    stopSpeaking();
    const rec = new SR();
    recRef.current = rec;
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      setInput((finalText + " " + interim).trim());
    };
    rec.onstart = () => setListening(true);
    rec.onend = () => { setListening(false); if (finalText.trim()) setInput(finalText.trim()); };
    rec.onerror = (e) => {
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed")
        setErr("Microphone blocked here. If you're in the app, try opening this in your browser \u2014 or type your answer.");
    };
    try { rec.start(); } catch { setListening(false); }
  }

  async function callProfessor(newHistory) {
    setBusy(true); setErr(null);
    try {
      const messages = [
        { role: "user", content: PROFESSOR_PROMPT + "\n\nBegin the cold call now." },
        ...newHistory.map(m => ({ role: m.role === "prof" ? "assistant" : "user", content: m.content })),
      ];
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages }),
      });
      const data = await res.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      if (!text) throw new Error("Empty response");
      setHistory([...newHistory, { role: "prof", content: text }]);
      speak(text);
    } catch (e) {
      setErr("The professor stepped out. Try again.");
    } finally { setBusy(false); }
  }

  function begin() { setStarted(true); callProfessor([]); }

  function send() {
    const t = input.trim();
    if (!t || busy) return;
    const next = [...history, { role: "student", content: t }];
    setHistory(next); setInput("");
    callProfessor(next);
  }

  let line = 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {!started ? (
        <div style={{ textAlign: "center", padding: "48px 20px" }}>
          <div style={{ fontFamily: T.serif, fontSize: 22, color: T.green, marginBottom: 8 }}>Contracts &middot; Cold Call</div>
          <div style={{ fontFamily: T.serif, fontSize: 15, color: T.faint, maxWidth: 420, margin: "0 auto 24px", lineHeight: 1.5 }}>
            The professor has your reading. When you sit down, you are on call for <em>Hawkins v. McGee</em>.
          </div>
          <button onClick={begin} disabled={busy} style={{
            appearance: "none", cursor: "pointer", border: `1px solid ${T.green}`,
            background: T.green, color: T.paper, fontFamily: T.sans, fontWeight: 600,
            fontSize: 14, letterSpacing: "0.04em", padding: "12px 28px", borderRadius: 2,
          }}>{busy ? "Class is settling\u2026" : "Take your seat"}</button>
        </div>
      ) : (
        <>
          <div style={{ flex: 1, overflowY: "auto", padding: "10px 0 16px" }}>
            {history.map((m, i) => {
              const rows = m.content.split("\n").filter(Boolean);
              return (
                <div key={i} style={{ margin: "14px 0" }}>
                  <div style={{ fontFamily: T.mono, fontSize: 11, letterSpacing: "0.08em", color: m.role === "prof" ? T.oxblood : T.green, marginBottom: 4 }}>
                    {m.role === "prof" ? "THE PROFESSOR:" : "THE STUDENT:"}
                  </div>
                  {rows.map((r, j) => (
                    <div key={j} style={{ display: "flex", gap: 12 }}>
                      <div style={{ fontFamily: T.mono, fontSize: 11, color: T.rule, width: 22, textAlign: "right", flexShrink: 0, paddingTop: 4 }}>{line++}</div>
                      <div style={{ fontFamily: T.serif, fontSize: 15.5, lineHeight: 1.6, color: T.ink }}>{r}</div>
                    </div>
                  ))}
                </div>
              );
            })}
            {busy && <div style={{ fontFamily: T.mono, fontSize: 12, color: T.faint, paddingLeft: 34 }}>The professor considers&hellip;</div>}
            {err && <div style={{ fontFamily: T.sans, fontSize: 13, color: T.oxblood, paddingLeft: 34 }}>{err}</div>}
            <div ref={endRef} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "6px 0 8px", fontFamily: T.sans, fontSize: 12 }}>
            <button onClick={() => { if (speaking) stopSpeaking(); setVoiceOn(!voiceOn); }} style={{
              appearance: "none", cursor: "pointer", border: `1px solid ${T.rule}`,
              background: voiceOn ? T.green : "transparent", color: voiceOn ? T.paper : T.faint,
              fontFamily: T.sans, fontSize: 11, fontWeight: 600, letterSpacing: "0.05em",
              padding: "5px 12px", borderRadius: 999,
            }}>{voiceOn ? "\u25CF Professor speaks" : "\u25CB Professor muted"}</button>
            {speaking && <button onClick={stopSpeaking} style={{ appearance: "none", border: "none", background: "none", cursor: "pointer", color: T.oxblood, fontFamily: T.sans, fontSize: 11, fontWeight: 600 }}>&#9632; Stop</button>}
            {!SR && <span style={{ color: T.faint }}>Dictation isn&rsquo;t supported in this browser &mdash; typing only.</span>}
          </div>
          <div style={{ borderTop: `1px solid ${T.rule}`, paddingTop: 12, display: "flex", gap: 10 }}>
            {SR && (
              <button onClick={toggleListen} disabled={busy} aria-label={listening ? "Stop dictating" : "Dictate your answer"} style={{
                appearance: "none", cursor: "pointer", flexShrink: 0, width: 46,
                border: `1px solid ${listening ? T.oxblood : T.rule}`,
                background: listening ? T.oxblood : "#FFFFFF",
                color: listening ? T.paper : T.green,
                borderRadius: 2, fontSize: 18,
                animation: listening ? "hubPulse 1.2s ease-in-out infinite" : "none",
              }}>{listening ? "\u25A0" : "\uD83C\uDF99"}</button>
            )}
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={listening ? "Listening\u2026 speak your answer" : "Answer the professor \u2014 type or tap the mic"}
              rows={2}
              style={{
                flex: 1, resize: "none", fontFamily: T.serif, fontSize: 15, lineHeight: 1.5,
                padding: "10px 12px", border: `1px solid ${T.rule}`, borderRadius: 2,
                background: "#FFFFFF", color: T.ink, outline: "none",
              }}
            />
            <button onClick={send} disabled={busy || !input.trim()} style={{
              appearance: "none", cursor: busy ? "wait" : "pointer",
              border: "none", background: busy || !input.trim() ? T.rule : T.oxblood,
              color: T.paper, fontFamily: T.sans, fontWeight: 600, fontSize: 13,
              letterSpacing: "0.05em", padding: "0 22px", borderRadius: 2,
            }}>Answer</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
export default function StudentHub() {
  const [tab, setTab] = useState("socratic");
  return (
    <div style={{ minHeight: "100vh", background: T.paper, display: "flex", flexDirection: "column" }}>
      <style>{`@keyframes hubPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(122,46,46,0.45);} 50% { box-shadow: 0 0 0 8px rgba(122,46,46,0);} } @media (prefers-reduced-motion: reduce){ *{animation:none!important} }`}</style>
      {/* Caption block — styled like a case caption */}
      <header style={{ background: T.greenDark, padding: "26px 24px 20px", borderBottom: `3px solid ${T.brass}` }}>
        <div style={{ maxWidth: 780, margin: "0 auto" }}>
          <div style={{ fontFamily: T.sans, fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: T.brass, marginBottom: 6 }}>
            Contextspaces &middot; Student Hub &middot; Prototype
          </div>
          <div style={{ fontFamily: T.serif, fontSize: "clamp(22px, 4vw, 30px)", color: T.paper, fontStyle: "italic" }}>
            Hawkins <span style={{ fontStyle: "normal", fontSize: "0.7em", opacity: 0.7 }}>v.</span> McGee
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 13, color: "rgba(250,248,242,0.65)", marginTop: 4 }}>
            84 N.H. 114, 146 A. 641 (1929) &middot; scanned from your casebook, ch. 1 &sect; 1
          </div>
        </div>
      </header>

      <nav style={{ borderBottom: `1px solid ${T.rule}`, background: T.paper, position: "sticky", top: 0, zIndex: 5 }}>
        <div style={{ maxWidth: 780, margin: "0 auto", display: "flex", gap: 4, padding: "8px 16px" }}>
          <Tab id="brief" label="Case brief" active={tab === "brief"} onClick={setTab} />
          <Tab id="outline" label="Outline" active={tab === "outline"} onClick={setTab} />
          <Tab id="socratic" label="Cold call" active={tab === "socratic"} onClick={setTab} />
        </div>
      </nav>

      <main style={{ flex: 1, maxWidth: 780, margin: "0 auto", width: "100%", padding: "22px 20px 30px", boxSizing: "border-box", display: "flex", flexDirection: "column" }}>
        {tab === "brief" && <BriefView />}
        {tab === "outline" && <OutlineView />}
        {tab === "socratic" && <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 420 }}><SocraticView /></div>}
      </main>
    </div>
  );
}
