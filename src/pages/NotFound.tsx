import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50">
      <h1 className="text-7xl font-bold text-slate-200">404</h1>
      <p className="text-slate-500 text-lg mt-4 mb-8">Page not found.</p>
      <Link
        to="/app"
        className="text-sm font-medium text-indigo-500 hover:text-indigo-600 transition-colors"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
