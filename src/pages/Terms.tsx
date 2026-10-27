// /terms — the agreement between Equazia.ai, Inc. and the people who use
// Equazia.ai.
//
// Public, linked from the landing page footer (which pointed at "#" until
// 2026-10-26) and from the sign-up form. Written to sit beside the Privacy
// page in the same voice: plain statements, each one true of the product as
// built. Drafted 2026-10-04 from the code and the billing rules, settled
// 2026-10-26. Eden (a lawyer) owns the wording; change it here, not in a CMS.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

const serif = { fontFamily: '"Playfair Display Variable", serif' } as const;
const UPDATED = '26 October 2026';
const CONTACT = 'info@equazia.ai';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-[20px] font-semibold text-white mb-2" style={serif}>{title}</h2>
      <div className="text-[15px] leading-relaxed text-[#b8b4be] space-y-3">{children}</div>
    </section>
  );
}

export default function Terms() {
  return (
    <div className="min-h-screen bg-black text-[#e8e4de]">
      <div className="max-w-2xl mx-auto px-5 sm:px-8 py-10">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[13px] text-[#8a8694] hover:text-[#e8e4de] transition-colors mb-10">
          <ArrowLeft size={14} /> Equazia.ai
        </Link>

        <header className="mb-10">
          <h1 className="text-[34px] sm:text-[42px] leading-[1.05] font-semibold tracking-tight text-white" style={serif}>Terms of Service</h1>
          <p className="mt-3 text-[13px] text-[#8a8694]">Last updated {UPDATED}. Equazia.ai is operated by Equazia.ai, Inc.</p>
          <p className="mt-4 text-[16px] leading-relaxed text-[#b8b4be]">
            Equazia.ai is a workspace for legal matters. These terms say what we provide, what you are responsible for,
            what it costs, and what happens when something goes wrong. They apply together with the{' '}
            <Link to="/privacy" className="text-[#e8e4de] underline underline-offset-2">Privacy</Link> page.
          </p>
        </header>

        <Section title="1. The agreement">
          <p>
            These terms are a contract between you and Equazia.ai, Inc. (“Equazia.ai”, “we”). You accept them by creating
            an account or by using the service. If you use Equazia.ai for a firm or another organization, you accept them
            for that organization and confirm that you have authority to do so. You must be at least 18.
          </p>
        </Section>

        <Section title="2. What Equazia.ai is, and is not">
          <p>
            Equazia.ai stores the documents of a matter, makes them searchable, keeps a record of what was done with them,
            and gives you and the AI assistants you choose a controlled way to work on them.
          </p>
          <p>
            Equazia.ai is not a law firm and does not practice law. Nothing the service produces is legal advice, and
            using it creates no attorney-client relationship with Equazia.ai, Inc. or with anyone who works on it.
          </p>
        </Section>

        <Section title="3. Your professional responsibility">
          <p>You remain the lawyer, or the person responsible, for your matter.</p>
          <p>
            AI output can be wrong. It can misstate a document, miss one, or cite an authority that does not say what is
            claimed or does not exist. You are responsible for reading and verifying anything the service or a connected
            assistant produces before you rely on it, file it, or send it to anyone.
          </p>
          <p>
            The Record, the AI Use Record and the citation checks are aids to your review. They are not a certification
            by us that a filing is accurate or that you have met any court rule, bar rule or duty to a client.
          </p>
          <p>
            You are responsible for deciding whether a document may be placed in Equazia.ai at all: client consent,
            protective orders, confidentiality agreements, court sealing orders and data-protection law are yours to
            observe.
          </p>
        </Section>

        <Section title="4. Your account">
          <p>
            Give accurate information and keep your sign-in details to yourself. You are responsible for what is done
            through your account, including by any assistant, agent, token or integration you connect. Owners and
            administrators of a firm’s space are asked to enrol a second factor, and a sealed matter opens only after
            you confirm it is you with one.
          </p>
          <p>
            If you believe your account has been compromised, use “Disconnect everything” on the Connections page,
            change your password, and tell us.
          </p>
        </Section>

        <Section title="5. Your content">
          <p>You keep every right you have in what you put into Equazia.ai. We claim no ownership of it.</p>
          <p>
            You give us permission to store, copy, process and display your content only as needed to provide the
            service to you and to the people you have given access to a matter. We do not sell it, do not use it to
            train AI models, and do not use it for any other purpose. How it is stored, who can see it and which outside
            services touch it are described on the Privacy page.
          </p>
          <p>
            You decide who is a member of a matter. People you add can see and do what their role allows; you are
            responsible for those choices.
          </p>
          <p>
            You confirm that you have the right to put your content into Equazia.ai and that doing so does not violate
            the law or anyone else’s rights.
          </p>
          <p>
            We treat your content as confidential. We do not intend our storage of it to waive any privilege or
            protection that belongs to you or your client. Whether a privilege is preserved in a particular case depends
            on the law that applies and on how you use the service, and we make no promise about that outcome.
          </p>
        </Section>

        <Section title="6. AI features and connected assistants">
          <p>
            When you ask a question, or a feature reads a document for you, the relevant passages are sent to an AI
            model provider to produce the result. Which provider depends on the matter’s settings and the model
            selected, as the Privacy page describes.
          </p>
          <p>
            A sealed matter (a SecureSpace) is not available to outside connectors, and its AI work runs only through
            the sealed route. Sealed matters are searched by words rather than by meaning.
          </p>
          <p>
            If you connect an outside assistant (Claude, ChatGPT, Gemini, Grok or another), what you type into it and
            what it shows you are also handled by that assistant’s provider under its own terms. We are not responsible
            for those services.
          </p>
          <p>Features marked beta or early access are offered as they are and may change or be withdrawn.</p>
        </Section>

        <Section title="7. Acceptable use">
          <p>Do not:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>use the service to break the law or to infringe anyone’s rights;</li>
            <li>try to reach a matter, account or system you are not entitled to;</li>
            <li>probe, scan or attack the service, or get around its limits or its security controls;</li>
            <li>upload malicious code;</li>
            <li>resell the service or let people outside your account use it through your sign-in;</li>
            <li>
              use it to build a competing product, or copy it in bulk by automated means beyond what the connectors and
              the API are documented to allow.
            </li>
          </ul>
        </Section>

        <Section title="8. Plans and payment">
          <p>
            Equazia.ai offers a free plan and paid monthly plans. The plans, their prices and what each includes are
            shown in Settings under Billing at the time you subscribe.
          </p>
          <p>
            Paid plans are billed monthly in advance through Stripe and renew each month until cancelled. Each plan
            includes a monthly allowance for AI and processing, counted by calendar month. An unused allowance does not
            carry over. When the allowance is spent, further usage is charged to usage credits if you have them;
            otherwise the features that consume the allowance stop until the next month or until you add credits.
          </p>
          <p>
            Usage credits are bought in packs, are charged once, and do not expire while your account is open. A pack
            may be labelled with a matter so that the receipt names it; the label does not restrict where the credits
            are spent.
          </p>
          <p>
            You may cancel at any time under “Manage billing”. Cancellation takes effect at the end of the month already
            paid for; you keep the plan until then. We do not refund a partial month or unused credits, except where
            the law requires it.
          </p>
          <p>
            If a payment fails we will try again for a short period; if it still fails, paid features stop until payment
            is made. Your content is not deleted for non-payment.
          </p>
          <p>
            We may change prices. A change applies from your next renewal after at least 30 days’ notice by email or
            inside the application. Prices do not include taxes, which are added where they apply.
          </p>
        </Section>

        <Section title="9. Ending the agreement">
          <p>You may stop using Equazia.ai and close your account at any time. Export anything you need before you close it.</p>
          <p>
            We may suspend or close an account that breaks these terms, that is unpaid, or that puts the service or
            other users at risk. Unless the risk is urgent, we will tell you first and give you a chance to fix it.
          </p>
          <p>
            Content that belongs to a firm’s space stays with the firm when one of its members leaves. After an account
            is closed we may delete its content.
          </p>
          <p>Sections 3, 5 (your confirmation), 10, 11, 12 and 13 continue after the agreement ends.</p>
        </Section>

        <Section title="10. The service as provided">
          <p>
            We work to keep Equazia.ai available and accurate, but we do not promise that it will be uninterrupted or
            free of error, that every document will be read or indexed correctly, or that any AI output will be correct
            or complete. Keep your own copies of anything you cannot afford to lose.
          </p>
          <p>
            To the extent the law allows, the service is provided “as is”, without warranties of any kind, express or
            implied, including warranties of merchantability, fitness for a particular purpose and non-infringement.
          </p>
        </Section>

        <Section title="11. Limit of liability">
          <p>To the extent the law allows:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              neither of us is liable to the other for indirect, incidental, special, consequential or punitive
              damages, or for lost profits, lost revenue, or the consequences of a missed deadline, a sanction, or an
              adverse result in any matter;
            </li>
            <li>
              our total liability for all claims connected with the service is limited to the greater of the amount
              you paid us in the 12 months before the claim arose and US $100.
            </li>
          </ul>
          <p>These limits do not apply to liability that cannot be limited by law.</p>
        </Section>

        <Section title="12. Claims by others">
          <p>
            If someone brings a claim against us because of your content, your use of the service in breach of these
            terms, or your breach of a duty you owe to a client, a court or a third party, you will defend us and cover
            the resulting loss, including reasonable legal fees. We will tell you promptly and let you control the
            defence.
          </p>
        </Section>

        <Section title="13. Law and disputes">
          <p>
            These terms are governed by the law of New Jersey, without regard to its conflict-of-laws rules. Any dispute
            will be heard in the state or federal courts located in New Jersey, and each of us accepts the jurisdiction
            of those courts.
          </p>
        </Section>

        <Section title="14. Changes to these terms">
          <p>
            We may change these terms. When we do, the date at the top changes, and a material change is announced by
            email or inside the application at least 30 days before it takes effect. If you keep using the service
            after that date, you accept the change. If you do not accept it, you may cancel before it takes effect.
          </p>
        </Section>

        <Section title="15. General">
          <p>
            These terms and the Privacy page are the whole agreement between us about the service. If a part of these
            terms cannot be enforced, the rest stays in force. Neither of us may assign this agreement without the
            other’s consent, except that we may assign it to a successor to the business. A failure to enforce a term
            is not a waiver of it.
          </p>
          <p>
            Notices and questions go to Equazia.ai, Inc., 245 Nassau Street, Princeton, NJ 08540, or to{' '}
            <a href={`mailto:${CONTACT}`} className="text-[#e8e4de] underline underline-offset-2">{CONTACT}</a>. Notices
            to you go to the email address on your account.
          </p>
        </Section>

        <p className="mt-12 text-[12px] text-[#5a5665]">
          See also: <Link to="/privacy" className="text-[#8a8694] underline underline-offset-2">Privacy</Link>.
        </p>
      </div>
    </div>
  );
}
