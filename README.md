# Context.ai

Your workspace, simplified. A modern productivity platform for small to mid-size teams.

## Tech Stack
- **Frontend**: React + TypeScript + Vite
- **Styling**: TailwindCSS v4
- **Backend**: Supabase (PostgreSQL, Auth, Realtime, Storage)
- **Editor**: TipTap (collaborative rich text)
- **AI**: Claude API (Opus 4.6)
- **Icons**: Lucide React

## Getting Started

1. Clone the repo
2. Copy `.env.example` to `.env` and fill in your Supabase credentials
3. Run the SQL migration in `supabase/migrations/001_initial_schema.sql` in your Supabase SQL editor
4. Install dependencies: `npm install`
5. Start dev server: `npm run dev`

## Project Structure
```
src/
├── components/     # Reusable UI components
│   ├── ai/         # AI Assistant
│   ├── auth/       # Authentication
│   ├── content/    # Content items (pages, lists, etc.)
│   ├── layout/     # Sidebar, breadcrumb, covers
│   ├── spaces/     # Space-specific components
│   └── ui/         # Generic UI components
├── contexts/       # React contexts (Auth)
├── hooks/          # Custom hooks
├── lib/            # Utilities, types, Supabase client
├── pages/          # Route pages
└── styles/         # Global styles
```

## Architecture
- **Clientspace**: Personal workspace (1 per user)
- **Serverspace**: Team/shared spaces with member management
- **Matterspace**: Sub-spaces within Serverspaces for focused work
- **Content**: Pages, Lists, Databases, Documents — nestable and cross-referenceable
