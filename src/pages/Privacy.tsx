// /privacy — how Contextspaces handles information.
//
// Public. Required by ChatGPT's GPT builder (a GPT with Actions must name a
// privacy policy URL) and linked from the landing page footer, which pointed
// at "#" until 2026-09-29. Written from what the system actually does — the
// per-matter access rules, the sealed tier, the Record, the connectors — not
// from a template. Plain statements; each one is true of the code as built.
// Eden (a lawyer) owns the wording; change it here, not in a CMS.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

const serif = { fontFamily: '"Playfair Display Variable", serif' } as const;
const UPDATED = '29 September 2026';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-[20px] font-semibold text-white mb-2" style={serif}>{title}</h2>
      <div className="text-[15px] leading-relaxed text-[#b8b4be] space-y-3">{children}</div>
    </section>
  );
}

export default function Privacy() {
  return (
    <div className="min-h-screen bg-black text-[#e8e4de]">
      <div className="max-w-2xl mx-auto px-5 sm:px-8 py-10">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-[#8a8694] hover:text-[#e8e4de] transition-colors mb-10">
          <ArrowLeft size={14} /> Contextspaces
        </Link>

        <header className="mb-10">
          <h1 className="text-[34px] sm:text-[42px] leading-[1.05] font-semibold tracking-tight text-white" style={serif}>Privacy</h1>
          <p className="mt-3 text-[13px] text-[#8a8694]">Last updated {UPDATED}. Contextspaces is operated by Grapheon.ai, LLC.</p>
          <p className="mt-4 text-[16px] leading-relaxed text-[#b8b4be]">
            Contextspaces holds legal matters: documents, transcripts, notes and the record of what was done with them.
            This page says what we store, who can see it, which outside services touch it, and how you end that.
          </p>
        </header>

        <Section title="What we store">
          <p>
            The documents you or your firm file into a matter, the text extracted from them so they can be searched,
            notes and pages you write, calendar entries, meeting transcripts you choose to record, and the account
            details needed to sign you in (your email address, a hashed password or a sign-in from a provider you chose,
            and any second factor you enrol).
          </p>
          <p>
            A per-matter <strong className="text-white">Record</strong> logs what was done: which tool ran, on which matter,
            touching which documents, asked by whom, and how it ended. The Record stores that metadata, never the
            content of a document or a question.
          </p>
        </Section>

        <Section title="Who can see it">
          <p>
            Access is decided per matter, in the database itself. You see a matter because you own it or were made a
            member of it; every query, from the website, a connected assistant or the API, runs under those same rules.
            Members of one matter cannot see another. A matter marked as a <strong className="text-white">SecureSpace</strong> is
            sealed further: it is invisible to every outside connector, and its AI work runs only through routes with
            no third-party retention.
          </p>
        </Section>

        <Section title="Where it lives">
          <p>
            Data is stored with Supabase (PostgreSQL and file storage) in the United States and served through Vercel.
            Files are encrypted at rest and in transit. Background processing (text extraction, optical character
            recognition, indexing) runs on servers we operate for that purpose.
          </p>
        </Section>

        <Section title="AI models">
          <p>
            When you ask an assistant a question, or a feature reads a document for you, the relevant passages are sent
            to a model provider to produce the answer. Which provider depends on the matter’s tier and on the model you
            or your firm selected: Anthropic, OpenAI, Google, xAI or a sealed route in our own cloud account with
            retention switched off. We use provider API terms under which your content is not used to train models.
            Passages are sent per request and are not retained by us beyond the answer that is filed or shown to you.
          </p>
        </Section>

        <Section title="Connected assistants (Claude, ChatGPT, Gemini, Grok, a Custom GPT)">
          <p>
            You may connect an outside assistant to your account. It signs in through Contextspaces (OAuth) or with a
            token you generate, and is then bound to the matters you approved on the consent screen. It receives the
            passages needed to answer and nothing else; it never receives your password. What you type into that
            assistant, and what it shows you, are also processed by its own provider under that provider’s terms.
            You can see every connection and revoke any of them at <strong className="text-white">Connections</strong> inside
            Contextspaces; revocation takes effect at once. “Disconnect everything” ends them all.
          </p>
        </Section>

        <Section title="Integrations you switch on">
          <p>
            Gmail, Google Calendar, Google Drive, Microsoft 365 and Dropbox connections exist only if you link them, do
            only what the linked feature says (import a calendar, save a file to a Drive folder, attach a document from
            Gmail), and can be unlinked in Settings. Payments are handled by Stripe; we do not store card numbers.
          </p>
        </Section>

        <Section title="What we do not do">
          <p>
            We do not sell information, share it with advertisers, or use matter content for anything except providing
            the service to the people entitled to that matter. We do not train models on your data. Staff access to
            stored content is limited to what is necessary to operate the service or to help you when you ask, and is
            itself recorded.
          </p>
        </Section>

        <Section title="Retention and deletion">
          <p>
            Content stays as long as the matter exists. Deleting a document removes it and its extracted text; deleting
            a matter removes everything in it. Backups age out on a rolling basis. Records of access (the Record) are
            kept for the life of the matter because they are part of the matter’s history. Closing an account removes
            its sign-in and its memberships; content a firm owns stays with the firm.
          </p>
        </Section>

        <Section title="Your choices">
          <p>
            You can export your documents, disconnect any assistant or integration, seal a matter, enrol a second
            factor, and ask us to delete your account. Questions about this page or about your information go to
            Grapheon.ai, LLC, 245 Nassau Street, Princeton, New Jersey, or to the firm that invited you to Contextspaces.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            When this page changes, the date at the top changes with it. Material changes are announced inside the
            application to signed-in users.
          </p>
        </Section>

        <p className="mt-12 text-[12px] text-[#5a5665]">
          See also: <Link to="/gpt-connect" className="text-[#8a8694] underline underline-offset-2">Contextspaces in ChatGPT</Link>.
        </p>
      </div>
    </div>
  );
}
