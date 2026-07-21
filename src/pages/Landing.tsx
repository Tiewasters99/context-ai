import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

const coreFeatures = [
  {
    title: 'Matterspaces',
    body: 'Every case, deal, or project gets its own matter — with pages, lists, tables, a calendar, deadlines, and a discussion thread. Matters nest into sub-matters and live in shared Serverspaces with your team, in strict isolation from one another.',
  },
  {
    title: 'The Vault',
    body: 'Load a matter’s documents into its Vault and they’re ingested, OCR’d, and indexed. Search everything at once — semantic and exact-match — and retrieval returns not summaries but verbatim passages with page-accurate citations: the form of answer you can actually put in a brief.',
  },
  {
    title: 'The Orchestrator',
    body: 'A native AI assistant that actually knows your matter. It searches your documents before it answers, opens the right file to the right page, and asks before it changes anything.',
  },
];

const suiteApps = [
  {
    title: 'Discovery',
    badge: null,
    body: 'Document review, privilege triage, and production — inside the workspace where the matter already lives. No export to a vendor silo, no per-gigabyte tax on your own evidence, and review output that lands as page-cited passages beside the briefs that will use them.',
  },
  {
    title: 'FileSaver.ai',
    badge: null,
    body: 'The suite’s chat-capture utility. Saves your AI conversations from ChatGPT, Claude, Gemini, and Grok and syncs them into Contextspaces — turning scattered, ephemeral sessions into a durable, searchable asset of the firm.',
  },
  {
    title: 'Oral Argument Prep',
    badge: null,
    body: 'Matter-scoped project environments for research, brief-writing, and oral argument preparation — with the record and your authorities a page-cited click away.',
  },
  {
    title: 'Storefronts',
    badge: 'Beta',
    body: 'An interactive, three-dimensional showcase of your practice with an AI receptionist that answers general questions and routes visitors toward consultation. Driven entirely by a showcase space you curate — and walled off from client matters by the platform’s isolation architecture.',
  },
  {
    title: 'Mediation Center',
    badge: 'Coming soon',
    body: 'AI-facilitated resolution for smaller two-party disputes, paired with what no other platform provides: independent attorney review of the proposed settlement for each side, at a flat fee that finally puts mediation within reach.',
  },
  {
    title: 'Bucketizer.ai',
    badge: 'Coming soon',
    body: 'A living outline of your case, built from the complaint and enriched dynamically with page-cited documents as discovery proceeds and the case file gets more complete.',
  },
];

const secondaryFeatures = [
  {
    title: 'Model-neutral AI',
    body: 'A hosted MCP server lets any leading model — Claude, ChatGPT, Gemini, or Grok — search, read, verify, and file documents in your Vault, subject to your permissions. You choose the intelligence; the workspace holds the matter.',
  },
  {
    title: 'Cite-Check',
    body: 'Drop in a brief and verify every citation against the record. Get a per-citation report and a ready table of authorities.',
  },
  {
    title: 'Meetings',
    body: 'Live transcription in the browser, saved to the matter. Flag key moments and ask the AI about what was said.',
  },
  {
    title: 'Document Reader',
    body: 'A full-screen reader for PDFs and Word documents with search, zoom, OCR, and annotations.',
  },
  {
    title: 'Your models, your keys',
    body: 'Claude built in, with BYOK support for GPT, Gemini, and Grok. Choose the model for each job in the AI Workbench.',
  },
  {
    title: 'Integrations',
    body: 'Gmail, Google Calendar, Google Drive, and Microsoft 365 — plus a Chrome extension that attaches Vault documents straight from Gmail.',
  },
  {
    title: 'A workspace with a soul',
    body: 'Customizable spaces drawing on a curated library of art and imagery, with music built in — a deliberate departure from utilitarian incumbent tools.',
  },
  {
    title: 'Built in live practice',
    body: 'Developed by a practicing litigator and used daily in an active state and federal trial docket. Every feature exists because a working lawyer needed it in a live case.',
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen">
      {/* Plain black hero — replaced the data-center photo for a more
          serious, simplified feel. */}
      <div
        className="relative min-h-screen flex flex-col"
        style={{ backgroundColor: '#000000' }}
      >

        {/* Nav */}
        <nav className="relative z-10 flex items-center justify-between w-full px-6 sm:pl-[8.9%] sm:pr-[10%] h-20">
          <span className="text-white" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>
            <span className="flex flex-col leading-none">
              <span className="text-[28px] sm:text-[36px] font-semibold tracking-tight" style={{ fontFamily: '"Playfair Display Variable", serif' }}>Context</span>
              <span className="text-[20px] sm:text-[25px] font-semibold tracking-tight" style={{ fontFamily: '"Playfair Display Variable", serif' }}><span className="text-[#d4a054]">Spaces</span><span className="text-white">.ai</span></span>
            </span>
          </span>
          {/* Desktop: the original absolutely-positioned link cluster. On
              phones it collides with the logo, so collapse to just Sign In. */}
          <div className="hidden sm:block relative" style={{ width: '500px' }}>
            <a href="#beta" className="absolute text-[20px] text-white hover:text-[#d4a054] transition-colors font-medium" style={{ right: '380px', textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>Beta</a>
            <a href="#features" className="absolute text-[20px] text-white hover:text-[#d4a054] transition-colors font-medium" style={{ right: '195px', textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>Features</a>
            <Link
              to="/auth"
              className="absolute text-[20px] font-semibold text-[#e8b84a] hover:text-[#f0c860] transition-colors" style={{ right: '50px', textShadow: '0 0 12px rgba(212,160,84,0.5), 0 1px 6px rgba(0,0,0,0.9)' }}
            >
              Sign In
            </Link>
          </div>
          <Link
            to="/auth"
            className="sm:hidden text-[18px] font-semibold text-[#e8b84a] hover:text-[#f0c860] transition-colors"
            style={{ textShadow: '0 0 12px rgba(212,160,84,0.5), 0 1px 6px rgba(0,0,0,0.9)' }}
          >
            Sign In
          </Link>
        </nav>

        {/* Hero — just words, no boxes */}
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 pb-20">
          <h1 className="text-[56px] sm:text-[84px] font-black text-white leading-[1.02] tracking-tight text-center" style={{ textShadow: '0 4px 16px rgba(0,0,0,1), 0 0 60px rgba(0,0,0,1), 0 0 100px rgba(0,0,0,0.8)' }}>
            Every matter,<br />
            <span className="text-[#d4a054]" style={{ textShadow: '0 4px 16px rgba(0,0,0,1), 0 0 60px rgba(0,0,0,1), 0 0 40px rgba(212,160,84,0.4)' }}>in context.</span>
          </h1>
          <p className="mt-8 text-[22px] sm:text-[26px] text-white max-w-2xl mx-auto leading-relaxed text-center font-bold" style={{ textShadow: '0 3px 14px rgba(0,0,0,1), 0 0 40px rgba(0,0,0,1), 0 0 60px rgba(0,0,0,0.7)' }}>
            The AI-native workspace for solo and small-firm litigators. Organize your matters, vault your documents, and put AI to work that cites its sources — page by page.
          </p>
          <div className="mt-10">
            <Link
              to="/auth"
              className="inline-flex items-center gap-2 text-[26px] font-semibold text-[#e8b84a] hover:text-[#f0c860] transition-colors"
              style={{ textShadow: '0 0 12px rgba(212,160,84,0.4), 0 1px 6px rgba(0,0,0,0.9)' }}
            >
              Get Started Free <ArrowRight size={18} strokeWidth={2} />
            </Link>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="relative z-10 flex justify-center pb-8">
          <div className="w-5 h-8 rounded-full border-2 border-white/30 flex items-start justify-center pt-1.5">
            <div className="w-1 h-2 rounded-full bg-white/50 animate-bounce" />
          </div>
        </div>
      </div>

      {/* Core features — just text, no cards */}
      <section id="features" className="bg-[#0a0a10] py-24 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-[11px] font-semibold text-[#d4a054] uppercase tracking-[0.2em] mb-8">What we do</h2>

          <div className="space-y-16">
            {coreFeatures.map((feature) => (
              <div key={feature.title}>
                <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">{feature.title}</h3>
                <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Divider — thin gold line */}
      <div className="bg-[#0a0a10] flex justify-center">
        <div className="w-16 h-px bg-[#d4a054]/40" />
      </div>

      {/* The Productivity Suite */}
      <section className="bg-[#0a0a10] py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-[11px] font-semibold text-[#d4a054] uppercase tracking-[0.2em] text-center mb-4">The Productivity Suite</h2>
          <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-xl mx-auto text-center mb-14">
            One workspace, and a suite of tools that grow with your case file — from the first complaint to the last argument.
          </p>
          <div className="grid sm:grid-cols-2 gap-x-14 gap-y-12">
            {suiteApps.map((app) => (
              <div key={app.title}>
                <h3 className="text-[19px] font-semibold text-[#f5f2ed] mb-2 flex items-center gap-2.5">
                  {app.title}
                  {app.badge && (
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#d4a054] border border-[#d4a054]/40 rounded-full px-2.5 py-0.5">
                      {app.badge}
                    </span>
                  )}
                </h3>
                <p className="text-[14px] text-[#8a8693] leading-relaxed">
                  {app.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Divider — thin gold line */}
      <div className="bg-[#0a0a10] flex justify-center">
        <div className="w-16 h-px bg-[#d4a054]/40" />
      </div>

      {/* Secondary features — quiet two-column grid */}
      <section className="bg-[#0a0a10] py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-[11px] font-semibold text-[#d4a054] uppercase tracking-[0.2em] text-center mb-14">And everything around it</h2>
          <div className="grid sm:grid-cols-2 gap-x-14 gap-y-12">
            {secondaryFeatures.map((feature) => (
              <div key={feature.title}>
                <h3 className="text-[17px] font-semibold text-[#f5f2ed] mb-2">{feature.title}</h3>
                <p className="text-[14px] text-[#8a8693] leading-relaxed">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Divider — thin gold line */}
      <div className="bg-[#0a0a10] flex justify-center">
        <div className="w-16 h-px bg-[#d4a054]/40" />
      </div>

      {/* Beta / early access */}
      <section id="beta" className="bg-[#0a0a10] py-24 px-6">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-[11px] font-semibold text-[#d4a054] uppercase tracking-[0.2em] mb-4">Early Access</h2>
          <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-6">Live today. Free during beta.</h3>
          <p className="text-[16px] text-[#8a8693] leading-relaxed mb-10">
            Contextspaces is in production and onboarding a hand-picked group of design partners — practicing
            litigators who shape the roadmap and are supported without charge throughout the beta. Per-seat
            subscription pricing arrives at public launch.
          </p>
          <Link
            to="/auth"
            className="inline-block bg-[#d4a054] hover:bg-[#c4903a] text-[#0e0e12] font-semibold text-[14px] rounded-md px-8 py-3 transition-colors"
          >
            Request Early Access
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[rgba(255,255,255,0.06)] bg-[#0a0a10]">
        <div className="max-w-5xl mx-auto px-6 py-12">
          <div className="flex flex-col md:flex-row justify-between gap-8">
            <div>
              <span className="text-[15px] font-semibold text-[#f5f2ed]">
                <span className="inline-flex flex-col leading-none">
                  <span>Context</span>
                  <span className="text-[#d4a054]">Spaces.ai</span>
                </span>
              </span>
              <p className="text-[12px] text-[#5a5665] mt-2">Every matter, in context.</p>
            </div>
            <div className="flex gap-14">
              <div>
                <h4 className="text-[12px] font-semibold text-[#e8e4de] mb-3">Product</h4>
                <ul className="space-y-2 text-[12px] text-[#5a5665]">
                  <li><a href="#features" className="hover:text-[#e8e4de] transition-colors">Features</a></li>
                  <li><a href="#beta" className="hover:text-[#e8e4de] transition-colors">Early Access</a></li>
                </ul>
              </div>
              <div>
                <h4 className="text-[12px] font-semibold text-[#e8e4de] mb-3">Company</h4>
                <ul className="space-y-2 text-[12px] text-[#5a5665]">
                  <li><a href="#" className="hover:text-[#e8e4de] transition-colors">About</a></li>
                  <li><a href="#" className="hover:text-[#e8e4de] transition-colors">Contact</a></li>
                </ul>
              </div>
              <div>
                <h4 className="text-[12px] font-semibold text-[#e8e4de] mb-3">Legal</h4>
                <ul className="space-y-2 text-[12px] text-[#5a5665]">
                  <li><a href="#" className="hover:text-[#e8e4de] transition-colors">Privacy</a></li>
                  <li><a href="#" className="hover:text-[#e8e4de] transition-colors">Terms</a></li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
