import { Link } from 'react-router-dom';
import { Layers, Users, Bot, Check, ArrowRight } from 'lucide-react';

const features = [
  {
    icon: Layers,
    title: 'Clientspaces',
    description: 'Your personal workspace. Organize pages, lists, and databases — all in one place.',
  },
  {
    icon: Users,
    title: 'Serverspaces',
    description: 'Collaborate with your team. Invite members, manage permissions, and work together in real-time.',
  },
  {
    icon: Bot,
    title: 'AI Assistant',
    description: 'A built-in assistant that understands your workspace. Navigate, create, and organize with natural language.',
  },
];

const tiers = [
  {
    name: 'Free',
    price: '$0',
    description: 'For individuals getting started',
    features: ['1 Clientspace', '3 Serverspaces', 'Basic AI (Blind mode)', 'Unlimited pages & lists', 'Community support'],
    cta: 'Get Started',
    highlighted: false,
  },
  {
    name: 'Pro',
    price: 'Coming Soon',
    description: 'For professionals and small teams',
    features: ['Everything in Free', 'Unlimited Serverspaces', 'All AI modes', 'Custom covers', '10 Matterspaces per Serverspace', 'Priority support'],
    cta: 'Join Waitlist',
    highlighted: true,
  },
  {
    name: 'Max',
    price: 'Coming Soon',
    description: 'For teams that need everything',
    features: ['Everything in Pro', 'Unlimited Matterspaces', 'API access', 'Advanced analytics', 'White-labeling', 'Dedicated support'],
    cta: 'Join Waitlist',
    highlighted: false,
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="flex items-center justify-between max-w-6xl mx-auto px-6 h-16">
        <span className="text-xl font-bold text-slate-900 tracking-tight">
          Context<span className="text-indigo-500">.ai</span>
        </span>
        <div className="flex items-center gap-6">
          <a href="#features" className="text-sm text-slate-500 hover:text-slate-900 transition-colors">Features</a>
          <a href="#pricing" className="text-sm text-slate-500 hover:text-slate-900 transition-colors">Pricing</a>
          <Link
            to="/auth"
            className="text-sm font-medium text-indigo-500 hover:text-indigo-600 transition-colors"
          >
            Sign In
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-24 pb-20 text-center">
        <h1 className="text-5xl sm:text-6xl font-bold text-slate-900 tracking-tight leading-tight">
          Your workspace,<br />
          <span className="text-indigo-500">simplified.</span>
        </h1>
        <p className="mt-6 text-lg text-slate-500 max-w-2xl mx-auto">
          The productivity platform that gets out of your way. Organize your work, collaborate with your team, and let AI handle the rest.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Link
            to="/auth"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium transition-colors"
          >
            Get Started Free <ArrowRight size={16} />
          </Link>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-slate-900 text-center mb-4">Everything you need</h2>
        <p className="text-slate-500 text-center mb-12 max-w-xl mx-auto">
          A clean, powerful workspace without the bloat. Built for teams that want to get things done.
        </p>
        <div className="grid md:grid-cols-3 gap-8">
          {features.map((f) => (
            <div key={f.title} className="p-6 rounded-2xl border border-slate-200 hover:border-slate-300 transition-colors">
              <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center mb-4">
                <f.icon size={20} className="text-indigo-500" />
              </div>
              <h3 className="text-lg font-semibold text-slate-900 mb-2">{f.title}</h3>
              <p className="text-sm text-slate-500 leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-slate-900 text-center mb-4">Simple pricing</h2>
        <p className="text-slate-500 text-center mb-12">Start free. Upgrade when you're ready.</p>
        <div className="grid md:grid-cols-3 gap-8">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`p-8 rounded-2xl border ${
                tier.highlighted
                  ? 'border-indigo-500 ring-1 ring-indigo-500'
                  : 'border-slate-200'
              }`}
            >
              <h3 className="text-lg font-semibold text-slate-900">{tier.name}</h3>
              <p className="text-sm text-slate-500 mt-1">{tier.description}</p>
              <p className="text-3xl font-bold text-slate-900 mt-4">{tier.price}</p>
              <ul className="mt-6 space-y-3">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-sm text-slate-600">
                    <Check size={16} className="text-emerald-500 shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Link
                to="/auth"
                className={`block text-center mt-8 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  tier.highlighted
                    ? 'bg-indigo-500 hover:bg-indigo-600 text-white'
                    : 'border border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                {tier.cta}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 mt-20">
        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="flex flex-col md:flex-row justify-between gap-8">
            <div>
              <span className="text-lg font-bold text-slate-900">
                Context<span className="text-indigo-500">.ai</span>
              </span>
              <p className="text-sm text-slate-500 mt-2">Your workspace, simplified.</p>
            </div>
            <div className="flex gap-12">
              <div>
                <h4 className="text-sm font-semibold text-slate-900 mb-3">Product</h4>
                <ul className="space-y-2 text-sm text-slate-500">
                  <li><a href="#features" className="hover:text-slate-900">Features</a></li>
                  <li><a href="#pricing" className="hover:text-slate-900">Pricing</a></li>
                </ul>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-900 mb-3">Company</h4>
                <ul className="space-y-2 text-sm text-slate-500">
                  <li><a href="#" className="hover:text-slate-900">About</a></li>
                  <li><a href="#" className="hover:text-slate-900">Contact</a></li>
                </ul>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-900 mb-3">Legal</h4>
                <ul className="space-y-2 text-sm text-slate-500">
                  <li><a href="#" className="hover:text-slate-900">Privacy</a></li>
                  <li><a href="#" className="hover:text-slate-900">Terms</a></li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
