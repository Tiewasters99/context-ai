// /support — help for Equazia for Word (the Word add-in) and Equazia.ai.
//
// Public. It is the SupportUrl in public/addin/manifest.xml and the "Support
// document link" in the Microsoft AppSource listing (docs/appsource/), so it
// must stay reachable without signing in. Same chrome and voice as Privacy
// and Terms. Eden (a lawyer) owns the wording; change it here, not in a CMS.
//
// DRAFT (2026-11-02): the response-time sentence ("we reply within one
// business day") awaits Eden's approval before the AppSource submission.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

const serif = { fontFamily: '"Playfair Display Variable", serif' } as const;
const CONTACT = 'info@equazia.ai';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-[20px] font-semibold text-white mb-2" style={serif}>{title}</h2>
      <div className="text-[15px] leading-relaxed text-[#b8b4be] space-y-3">{children}</div>
    </section>
  );
}

export default function Support() {
  const mail = (
    <a href={`mailto:${CONTACT}?subject=${encodeURIComponent('Equazia support')}`} className="text-[#e8e4de] underline underline-offset-2">
      {CONTACT}
    </a>
  );
  return (
    <div className="min-h-screen bg-black text-[#e8e4de]">
      <div className="max-w-2xl mx-auto px-5 sm:px-8 py-10">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-[#8a8694] hover:text-[#e8e4de] transition-colors mb-10">
          <ArrowLeft size={14} /> Equazia.ai
        </Link>

        <header className="mb-10">
          <h1 className="text-[34px] sm:text-[42px] leading-[1.05] font-semibold tracking-tight text-white" style={serif}>Support</h1>
          <p className="mt-3 text-[13px] text-[#8a8694]">Equazia.ai and Equazia for Word are operated by Equazia.ai, Inc.</p>
        </header>

        <Section title="Equazia for Word">
          <p>
            Equazia for Word is a task pane inside Microsoft Word that connects the document you are writing to its
            matter in Equazia.ai. From the pane you save the document to the matter as a new version, and you confirm
            the brief: every citation is checked against the matter, opened at the page it cites, and signed off with
            your initials.
          </p>
        </Section>

        <Section title="Installing it">
          <p>
            In Word, go to the Home tab, choose Add-ins, and search for Equazia. Once it is added, an Equazia button
            appears on the Home tab; press it to open the pane and sign in with your Equazia.ai account. The pane works
            in Word on Windows, Word on Mac and Word on the web with a Microsoft 365 subscription.
          </p>
          <p>
            An Equazia.ai account and subscription are required. If you do not have one yet, start at{' '}
            <Link to="/auth" className="text-[#e8e4de] underline underline-offset-2">www.equazia.ai/auth</Link>.
          </p>
        </Section>

        <Section title="Getting help">
          <p>
            Email {mail}. To help us find the problem quickly, include:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>the version of Word (in Word, File → Account → About Word) and whether it is Windows, Mac or the web;</li>
            <li>your operating system and its version;</li>
            <li>the exact text of any error message, or a screenshot of the pane;</li>
            <li>what you pressed just before it happened.</li>
          </ul>
          <p>
            Please do not send the contents of a confidential document by email; describe it instead, or name the
            matter and document as they appear in Equazia.ai.
          </p>
          <p>We reply within one business day.</p>
        </Section>

        <Section title="Your account and your information">
          <p>
            For sign-in problems, use “Forgot password” at{' '}
            <Link to="/auth" className="text-[#e8e4de] underline underline-offset-2">www.equazia.ai/auth</Link> or write to {mail}.
            How we handle your information, including what the Word add-in sends and stores, is set out in the{' '}
            <Link to="/privacy" className="text-[#e8e4de] underline underline-offset-2">Privacy</Link> page.
          </p>
        </Section>

        <p className="mt-12 text-[12px] text-[#5a5665]">
          See also: <Link to="/help" className="text-[#8a8694] underline underline-offset-2">Help</Link> ·{' '}
          <Link to="/privacy" className="text-[#8a8694] underline underline-offset-2">Privacy</Link> ·{' '}
          <Link to="/terms" className="text-[#8a8694] underline underline-offset-2">Terms of Service</Link>.
        </p>
      </div>
    </div>
  );
}
