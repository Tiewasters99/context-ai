import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

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
          <h1 className="text-[56px] sm:text-[80px] font-black text-white leading-[1.05] tracking-tight text-center" style={{ textShadow: '0 4px 16px rgba(0,0,0,1), 0 0 60px rgba(0,0,0,1), 0 0 100px rgba(0,0,0,0.8)' }}>
            Every case file,<br />
            <span className="text-[#d4a054]" style={{ textShadow: '0 4px 16px rgba(0,0,0,1), 0 0 60px rgba(0,0,0,1), 0 0 40px rgba(212,160,84,0.4)' }}>one question away.</span>
          </h1>
          <p className="mt-8 text-[22px] sm:text-[26px] text-white max-w-2xl mx-auto leading-relaxed text-center font-bold" style={{ textShadow: '0 3px 14px rgba(0,0,0,1), 0 0 40px rgba(0,0,0,1), 0 0 60px rgba(0,0,0,0.7)' }}>
            Contextspaces turns everything you feed it — scanned exhibits, depositions, recordings, emails — into source material for you and any frontier AI to work with. Your clients stay separated. Built by a litigator.
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

      {/* Features — just text, no cards */}
      <section id="features" className="bg-[#0a0a10] py-24 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-[11px] font-semibold text-[#d4a054] uppercase tracking-[0.2em] mb-8">What you can do</h2>

          <div className="space-y-16">
            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">Feed it anything</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                Scanned PDFs are OCR&rsquo;d. Depositions, hearings, and meetings are transcribed from
                audio and video. Emails arrive with their attachments; decks and Office documents
                extract cleanly. Everything becomes searchable, citable text — and every matter
                stays behind its own wall.
              </p>
            </div>

            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">Work with any model you choose</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                Claude, ChatGPT, Gemini, and Grok connect directly to your matters. Draft, analyze,
                edit, and proofread across hundreds — even thousands — of files with whichever model
                you trust for the job. Your documents live in one place; the AI comes to them.
              </p>
            </div>

            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">Keep every conversation</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                Your AI chats are captured into the workspace — searchable, retrievable, and ready
                to be analyzed like any other source material. The thinking you do with a model
                stops evaporating when the tab closes.
              </p>
            </div>

            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">Prepare for oral argument</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                Moot Bench puts your motion in front of a hot bench of frontier models — or pairs
                you with a brilliant colleague to pressure-test the argument before the one that
                counts.
              </p>
            </div>

            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">Serve and respond to discovery</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                A review room for every production: classify and sort the corpus against the
                demands, key everything to the controlling inventory, and produce — with the lawyer
                making every call.
              </p>
            </div>

            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">Check every citation</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                Cite-checking runs against real sources and your matter&rsquo;s own record, so a
                quote that drifted from the transcript gets caught before a judge catches it.
              </p>
            </div>

            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">Resolve it in the Mediation Center</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                A dedicated space for structured negotiation — register a case, bring the other
                side in, and let both parties work from the same record.
              </p>
            </div>

            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">
                Open a storefront in three dimensions
                <span className="ml-3 align-middle text-[11px] font-semibold text-[#d4a054] uppercase tracking-[0.2em]">Beta</span>
              </h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                The more your practice lives in Contextspaces, the more it can power a specialized
                3-D storefront on Grapheon — a navigable office with proprietary art and music and
                an AI receptionist who answers general questions about your practice and routes
                visitors to a consultation with you.{' '}
                <a
                  href="https://grapheon.ai/miniverses"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#d4a054] hover:text-[#e8b84a] transition-colors"
                >
                  Step into the first one: Quainton Law — The Offices
                </a>.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Divider — thin gold line */}
      <div className="bg-[#0a0a10] flex justify-center">
        <div className="w-16 h-px bg-[#d4a054]/40" />
      </div>

      {/* Credibility — one line, no logos */}
      <section className="bg-[#0a0a10] py-20 px-6">
        <p className="text-[18px] text-[#c9c4bb] leading-relaxed max-w-xl mx-auto text-center">
          Contextspaces is built and used daily by a practicing litigator with an active state and
          federal docket. Every feature exists because a live case demanded it.
        </p>
      </section>

      {/* Divider — thin gold line */}
      <div className="bg-[#0a0a10] flex justify-center">
        <div className="w-16 h-px bg-[#d4a054]/40" />
      </div>

      {/* Early access — replaces pricing until billing is real */}
      <section id="get-started" className="bg-[#0a0a10] py-24 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-[11px] font-semibold text-[#d4a054] uppercase tracking-[0.2em] mb-4">Early access</h2>
          <h3 className="text-[24px] font-semibold text-[#f5f2ed] mb-4">Free while we build.</h3>
          <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto mb-10">
            Bring a matter and put it to work. Pricing arrives when it&rsquo;s earned — not before.
          </p>
          <Link
            to="/auth"
            className="inline-flex items-center gap-2 px-7 py-3 rounded-md text-[15px] font-semibold bg-[#d4a054] hover:bg-[#c4903a] text-[#0e0e12] transition-colors"
          >
            Get Started Free <ArrowRight size={16} strokeWidth={2} />
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
              <p className="text-[12px] text-[#5a5665] mt-2">Every case file, one question away.</p>
            </div>
            <div className="flex gap-14">
              <div>
                <h4 className="text-[12px] font-semibold text-[#e8e4de] mb-3">Product</h4>
                <ul className="space-y-2 text-[12px] text-[#5a5665]">
                  <li><a href="#features" className="hover:text-[#e8e4de] transition-colors">Features</a></li>
                  <li><a href="#get-started" className="hover:text-[#e8e4de] transition-colors">Early Access</a></li>
                </ul>
              </div>
              {/* Company and Legal columns return when their pages exist —
                  href="#" links on Privacy/Terms are a credibility hole for a
                  product that asks lawyers to upload client files. */}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
