import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';

const tiers = [
  {
    name: 'Free',
    price: '$0',
    description: 'For individuals getting started',
    features: [
      '1 Contextspace',
      '3 Serverspaces',
      '5 GB Vault storage',
      '50 AI requests/month (Sonnet)',
      'Blind AI mode only',
      'Unlimited pages & lists',
      'Community support',
    ],
    cta: 'Get Started',
    highlighted: false,
  },
  {
    name: 'Pro',
    price: '$29/mo',
    description: 'For professionals and small teams',
    features: [
      'Everything in Free',
      'Unlimited Serverspaces',
      '100 GB Vault storage',
      'Unlimited Sonnet + 500 Opus/month',
      'All AI modes (Blind, Observer, Collaborative)',
      'Bring Your Own Key',
      '10 Matterspaces per Serverspace',
      'Priority support',
    ],
    cta: 'Get Started',
    highlighted: true,
  },
  {
    name: 'Max',
    price: '$79/mo',
    description: 'For teams that need everything',
    features: [
      'Everything in Pro',
      '1 TB Vault storage',
      'Unlimited Opus requests',
      'Connected storage (OneDrive, Google Drive)',
      'Unlimited Matterspaces',
      'Advanced permissions & audit logs',
      'White-labeling',
      'Dedicated support',
    ],
    cta: 'Get Started',
    highlighted: false,
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen">
      {/* Full-bleed GPU cluster hero */}
      <div
        className="relative min-h-screen bg-cover bg-center bg-fixed bg-no-repeat flex flex-col"
        style={{ backgroundImage: "url('/gpu-cluster.png')" }}
      >
        {/* Gradient overlay — darker at edges for text readability */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(10,10,16,0.2)_100%)]" />

        {/* Nav */}
        <nav className="relative z-10 flex items-center justify-between w-full pl-[8.9%] pr-[10%] h-20">
          <span className="text-white" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>
            <span className="flex flex-col leading-none">
              <span className="text-[36px] font-semibold tracking-tight" style={{ fontFamily: '"Playfair Display Variable", serif' }}>Context</span>
              <span className="text-[25px] font-semibold tracking-tight" style={{ fontFamily: '"Playfair Display Variable", serif' }}><span className="text-[#d4a054]">Spaces</span><span className="text-white">.ai</span></span>
            </span>
          </span>
          <div className="relative" style={{ width: '500px' }}>
            <a href="#pricing" className="absolute text-[20px] text-white hover:text-[#d4a054] transition-colors font-medium" style={{ right: '380px', textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>Pricing</a>
            <a href="#features" className="absolute text-[20px] text-white hover:text-[#d4a054] transition-colors font-medium" style={{ right: '195px', textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>Features</a>
            <Link
              to="/auth"
              className="absolute text-[20px] font-semibold text-[#e8b84a] hover:text-[#f0c860] transition-colors" style={{ right: '50px', textShadow: '0 0 12px rgba(212,160,84,0.5), 0 1px 6px rgba(0,0,0,0.9)' }}
            >
              Sign In
            </Link>
          </div>
        </nav>

        {/* Hero — just words, no boxes */}
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 pb-20">
          <h1 className="text-[72px] sm:text-[90px] font-black text-white leading-[1.02] tracking-tight text-center" style={{ textShadow: '0 4px 16px rgba(0,0,0,1), 0 0 60px rgba(0,0,0,1), 0 0 100px rgba(0,0,0,0.8)' }}>
            Your workspace,<br />
            <span className="text-[#d4a054]" style={{ textShadow: '0 4px 16px rgba(0,0,0,1), 0 0 60px rgba(0,0,0,1), 0 0 40px rgba(212,160,84,0.4)' }}>simplified.</span>
          </h1>
          <p className="mt-8 text-[26px] text-white max-w-xl mx-auto leading-relaxed text-center font-bold" style={{ textShadow: '0 3px 14px rgba(0,0,0,1), 0 0 40px rgba(0,0,0,1), 0 0 60px rgba(0,0,0,0.7)' }}>
            The productivity platform that gets out of your way. Organize your work, collaborate with your team, and let us do the rest.
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
          <h2 className="text-[11px] font-semibold text-[#d4a054] uppercase tracking-[0.2em] mb-8">What we do</h2>

          <div className="space-y-16">
            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">Contextspaces</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                Your home base. A clean, organized view of all your Serverspaces — always one click away, never buried.
              </p>
            </div>

            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">Serverspaces</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                Your matters and projects live here. Pages, lists, databases, members — everything configured in one place.
              </p>
            </div>

            <div>
              <h3 className="text-[28px] font-semibold text-[#f5f2ed] mb-3">AI Assistant</h3>
              <p className="text-[16px] text-[#8a8693] leading-relaxed max-w-lg mx-auto">
                A native AI assistant built into Contextspaces.ai from the start — not an add-on or afterthought that guesses at what you need.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Divider — thin gold line */}
      <div className="bg-[#0a0a10] flex justify-center">
        <div className="w-16 h-px bg-[#d4a054]/40" />
      </div>

      {/* Pricing */}
      <section id="pricing" className="bg-[#0a0a10] py-24 px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-[11px] font-semibold text-[#d4a054] uppercase tracking-[0.2em] text-center mb-4">Pricing</h2>
          <h3 className="text-[24px] font-semibold text-[#f5f2ed] text-center mb-14">Start free. Upgrade when you're ready.</h3>
          <div className="grid md:grid-cols-3 gap-5">
            {tiers.map((tier) => (
              <div
                key={tier.name}
                className={`p-7 rounded-lg border ${
                  tier.highlighted
                    ? 'border-[#d4a054]/50 bg-[#d4a054]/[0.04]'
                    : 'border-[rgba(255,255,255,0.06)] bg-transparent'
                }`}
              >
                <h3 className="text-[15px] font-semibold text-[#f5f2ed]">{tier.name}</h3>
                <p className="text-[12px] text-[#8a8693] mt-1">{tier.description}</p>
                <p className="text-[28px] font-semibold text-[#f5f2ed] mt-4">{tier.price}</p>
                <ul className="mt-6 space-y-2.5">
                  {tier.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2.5 text-[13px] text-[#8a8693]">
                      <Check size={14} className="text-[#d4a054] shrink-0" strokeWidth={2} />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Link
                  to="/auth"
                  className={`block text-center mt-7 py-2.5 rounded-md text-[13px] font-medium transition-colors ${
                    tier.highlighted
                      ? 'bg-[#d4a054] hover:bg-[#c4903a] text-[#0e0e12] font-semibold'
                      : 'border border-[rgba(255,255,255,0.1)] text-[#e8e4de] hover:bg-[rgba(255,255,255,0.04)]'
                  }`}
                >
                  {tier.cta}
                </Link>
              </div>
            ))}
          </div>
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
              <p className="text-[12px] text-[#5a5665] mt-2">Your workspace, simplified.</p>
            </div>
            <div className="flex gap-14">
              <div>
                <h4 className="text-[12px] font-semibold text-[#e8e4de] mb-3">Product</h4>
                <ul className="space-y-2 text-[12px] text-[#5a5665]">
                  <li><a href="#features" className="hover:text-[#e8e4de] transition-colors">Features</a></li>
                  <li><a href="#pricing" className="hover:text-[#e8e4de] transition-colors">Pricing</a></li>
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
