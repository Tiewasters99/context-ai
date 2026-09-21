import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center">
      {/* --color-text-primary is not a variable this app defines (the token is
          --color-text, src/styles/index.css). An undefined var makes the
          heading inherit whatever colour happens to be in scope. */}
      <h1 className="text-7xl font-bold text-[var(--color-text)]">404</h1>
      <p className="text-[#8a8693] text-lg mt-4 mb-8">Page not found.</p>
      <Link
        to="/app"
        className="text-sm font-medium text-[#d4a054] hover:text-[#c4903a] transition-colors"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
