// /gpt-connect — Contextspaces in ChatGPT, on a phone.
//
// Public. The audience is a client or colleague holding a phone: someone
// whose lawyer has given them a Contextspaces account and who wants to ask
// about the matter from the ChatGPT app. ChatGPT's custom MCP connectors are
// desktop-web only; a Custom GPT with Actions runs in the phone apps with
// nothing to enable. This page says what it is, how to start, what it can
// and cannot do, and how to switch it off. The lawyer's set-up (creating the
// GPT, minting its client) is in docs/specs/GPT-ACTIONS-2026-09-29.md and is
// summarised at the foot of the page.
//
// The GPT's own link exists only once Eden has created it in the builder;
// until then the page says the lawyer will send it.

import { Link } from 'react-router-dom';
import { ArrowLeft, Smartphone, ShieldCheck, Lock, Search, FileText, Power } from 'lucide-react';

// Filled in once the GPT exists (its share link from the builder). Empty →
// the page tells the reader to use the link their lawyer sent.
const GPT_LINK = 'https://chatgpt.com/g/g-6abc520052988191b96cc5fb3b125c43';

const serif = { fontFamily: '"Playfair Display Variable", serif' } as const;

export default function GptConnect() {
  return (
    <div className="min-h-screen bg-black text-[#e8e4de]">
      <div className="max-w-2xl mx-auto px-5 sm:px-8 py-10">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-[#8a8694] hover:text-[#e8e4de] transition-colors mb-10">
          <ArrowLeft size={14} /> Contextspaces
        </Link>

        <header className="mb-10">
          <div className="inline-flex items-center gap-2 text-[12px] uppercase tracking-[0.16em] text-[#d4a054] mb-3">
            <Smartphone size={14} /> On your phone
          </div>
          <h1 className="text-[34px] sm:text-[42px] leading-[1.05] font-semibold tracking-tight text-white" style={serif}>
            Contextspaces in ChatGPT
          </h1>
          <p className="mt-4 text-[16px] leading-relaxed text-[#b8b4be]">
            Ask about your matter from the ChatGPT app. The Contextspaces GPT reads the documents your
            lawyer has filed for you and answers from them, citing the document and page every time.
            Nothing to install and nothing to enable: open the GPT, sign in to Contextspaces once, and ask.
          </p>
        </header>

        <section className="mb-10 rounded-xl border border-white/[0.1] bg-white/[0.03] p-6">
          <h2 className="text-[20px] font-semibold text-white mb-4" style={serif}>Getting started</h2>
          <ol className="space-y-4 text-[15px] leading-relaxed text-[#b8b4be]">
            <li className="flex gap-3">
              <span className="text-[#d4a054] font-mono shrink-0">1.</span>
              <span>
                <strong className="text-white">Have a Contextspaces account.</strong> Your lawyer creates it and sends you
                an invitation. You will set a password the first time. There is no public sign-up.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#d4a054] font-mono shrink-0">2.</span>
              <span>
                <strong className="text-white">Open the Contextspaces GPT in ChatGPT.</strong>{' '}
                {GPT_LINK ? (
                  <>Tap <a href={GPT_LINK} className="text-[#e8b84a] underline underline-offset-2">this link</a> on your phone; it opens in the ChatGPT app.</>
                ) : (
                  <>Your lawyer will send you its link; it opens in the ChatGPT app (iPhone or Android). A free ChatGPT account is enough.</>
                )}
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#d4a054] font-mono shrink-0">3.</span>
              <span>
                <strong className="text-white">Ask something.</strong> The first time, ChatGPT will say the GPT wants to
                sign in to Contextspaces. Tap <em>Sign in</em>, enter your Contextspaces email and password, and choose
                what the GPT may see: everything you can open, or only the matters you tick. Tap <em>Approve</em> and you
                are back in ChatGPT.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="text-[#d4a054] font-mono shrink-0">4.</span>
              <span>
                <strong className="text-white">Keep asking.</strong> “What did the petition say about the Holder Rule?”
                “Find every place the hearing transcript mentions the deposit.” “Where do things stand on my case?”
                Answers cite the document and the page (and line, on a transcript), so you and your lawyer can check them.
              </span>
            </li>
          </ol>
        </section>

        <section className="mb-10 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.1] p-5">
            <div className="flex items-center gap-2 text-white mb-2"><Search size={16} className="text-[#d4a054]" /><h3 className="font-semibold">What it can do</h3></div>
            <ul className="text-[14px] leading-relaxed text-[#b8b4be] space-y-1.5 list-disc pl-4">
              <li>List your matters and the documents in them.</li>
              <li>Search a matter, or all of them, and quote passages with citations.</li>
              <li>Find an exact phrase everywhere in a matter.</li>
              <li>Read a document’s outline, or one passage with the pages around it.</li>
              <li>Tell you where the matter stands (your lawyer’s notes).</li>
              <li>File a short note or draft into a matter, and pick up a task your lawyer has left for you — it asks you before it writes anything.</li>
            </ul>
          </div>
          <div className="rounded-xl border border-white/[0.1] p-5">
            <div className="flex items-center gap-2 text-white mb-2"><Lock size={16} className="text-[#d4a054]" /><h3 className="font-semibold">What it will not do</h3></div>
            <ul className="text-[14px] leading-relaxed text-[#b8b4be] space-y-1.5 list-disc pl-4">
              <li>Show anything you could not open yourself in Contextspaces.</li>
              <li>Answer about a sealed matter (a SecureSpace); it tells you it is sealed.</li>
              <li>Download or send your files anywhere; it reads text and cites it.</li>
              <li>Move, delete or rewrite documents.</li>
              <li>Give legal advice. It reports what the record says; your lawyer advises.</li>
            </ul>
          </div>
        </section>

        <section className="mb-10 rounded-xl border border-[#d4a054]/30 bg-[#d4a054]/[0.06] p-6">
          <div className="flex items-center gap-2 text-white mb-2"><ShieldCheck size={16} className="text-[#d4a054]" /><h3 className="font-semibold">How your information is handled</h3></div>
          <p className="text-[14px] leading-relaxed text-[#b8b4be]">
            Every question runs as you, inside the matters you approved, under the same access rules as the
            Contextspaces website. ChatGPT holds a sign-in credential for Contextspaces, not your password, and
            receives only the passages needed to answer. What you ask ChatGPT and what it shows you are also handled by
            OpenAI under its own terms. Details: <Link to="/privacy" className="text-[#e8b84a] underline underline-offset-2">Contextspaces privacy</Link>.
          </p>
        </section>

        <section className="mb-12 rounded-xl border border-white/[0.1] p-6">
          <div className="flex items-center gap-2 text-white mb-2"><Power size={16} className="text-[#d4a054]" /><h3 className="font-semibold">Switching it off</h3></div>
          <p className="text-[14px] leading-relaxed text-[#b8b4be]">
            Sign in to Contextspaces on any device, open <strong className="text-white">Connections</strong>, and disconnect the
            GPT. It loses access at once; nothing you filed is affected. Deleting the GPT from ChatGPT alone does not
            revoke it — do it from Contextspaces.
          </p>
        </section>

        <section className="border-t border-white/[0.08] pt-8">
          <div className="flex items-center gap-2 text-[#8a8694] mb-2"><FileText size={14} /><h3 className="text-[13px] uppercase tracking-[0.14em]">For the lawyer setting it up</h3></div>
          <p className="text-[13px] leading-relaxed text-[#8a8694]">
            The GPT is built once, in ChatGPT’s GPT builder, from the OpenAPI document at{' '}
            <code className="text-[#b8b4be]">/api/gpt/openapi.json</code> with OAuth (client id and secret minted at{' '}
            <Link to="/app/connections/gpt-client" className="text-[#b8b4be] underline underline-offset-2">Connections › mint a GPT client</Link>, authorize URL <code className="text-[#b8b4be]">/oauth/authorize</code>,
            token URL <code className="text-[#b8b4be]">/api/oauth-token</code>, scope <code className="text-[#b8b4be]">contextspaces</code>) and the instructions in{' '}
            <code className="text-[#b8b4be]">docs/specs/gpt-instructions.md</code>. Share it “anyone with the link”; each person signs in with their own
            Contextspaces account, so what they see is theirs. The full recipe is <code className="text-[#b8b4be]">docs/specs/GPT-ACTIONS-2026-09-29.md</code>.
            Colleagues on a computer can use the ChatGPT connector instead: <Link to="/app/connections/chatgpt" className="text-[#b8b4be] underline underline-offset-2">Connections › ChatGPT</Link>.
          </p>
        </section>
      </div>
    </div>
  );
}
