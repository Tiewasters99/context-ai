// The Editor's Room — the front door of the Contextspaces Editor.
// A placeholder with an identity: the room and its occupant are real, the
// desk is not yet open. The Editor's charter and margin vocabulary live in
// docs/editor/CONSTITUTION.md; the room gains its manuscript desk when the
// first editing pass ships.

const CORRECTIVE = [
  'obscure',
  'transition',
  'choppy',
  'repetitive',
  'weak',
  'vague',
  'awkward',
  'diction',
  'barbare',
];
const PRAISE = ['excellent', 'very sharp', 'yes!', 'brilliant'];

export default function EditorRoom() {
  return (
    <div className="relative h-full min-h-[480px] overflow-hidden bg-black animate-[fadeIn_1.4s_ease-out]">
      <img
        src="/editor/the-editor.png"
        alt="The Editor, waiting in a wood-panelled study"
        className="absolute inset-0 w-full h-full object-cover"
        style={{ objectPosition: '50% 30%' }}
      />

      {/* Blend the square photograph into the app chrome and hold a legible
          band at the foot of the room for the nameplate. */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-black/35" />
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at 50% 40%, transparent 55%, rgba(0,0,0,0.55) 100%)' }}
      />

      <div className="absolute inset-x-0 bottom-0 px-6 sm:px-10 pb-8 sm:pb-10">
        <p className="text-[11px] font-semibold tracking-[0.3em] uppercase text-[#e8b84a]">
          The Contextspaces Editor
        </p>
        <p
          className="mt-3 max-w-xl text-[17px] sm:text-[19px] leading-snug text-[#f5f2ed]"
          style={{ fontFamily: 'Georgia, serif' }}
        >
          Bring any AI draft — a brief, a memo, a letter. The Editor improves, clarifies and
          polishes until the writing is clear, direct and logical.
        </p>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-white/60">
          Guided by the Contextspaces Founder and frontier intelligence, the Editor works the
          old-fashioned way: comments in the margin, then a proposed edit. Every change shown in
          a redline. Click through to approve or add your own changes.
        </p>

        <div className="mt-5 flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-[#c96852] opacity-60 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#c96852]" />
          </span>
          <span className="text-[12px] text-white/70">In training — the desk opens soon.</span>
        </div>

        {/* The margin vocabulary, as ambience: the red pen and the praise. */}
        <p className="mt-4 text-[12px] italic text-white/35" style={{ fontFamily: 'Georgia, serif' }}>
          <span className="text-[#c96852]/80">{CORRECTIVE.join(' · ')}</span>
          <span className="text-white/25">&ensp;—&ensp;</span>
          <span className="text-[#e8b84a]/80">{PRAISE.join(' · ')}</span>
        </p>
      </div>
    </div>
  );
}
