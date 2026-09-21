# Hidden also means locked

One setting per account decides what Contextspaces shows: `profiles.pricing_tier`
∈ `free` / `basic` / `pro` / `max` / `workshop`. `workshop` is Eden's own
account and sees everything; every other plan sees the focused core.

Until 2026-09-21 that decided what the **bundle drew** and nothing else. Every
`/api/*` handler authenticated its caller and then served them whatever they
asked for, so a frozen room was hidden from the menu and open to `curl` — and
`api/mediation.mjs`, which spends our own Anthropic and OpenAI keys, had no
meter on it at all.

This is how that is now closed, and what to do when you add a room.

---

## One table, three readers

`lib/surfaces.mjs` is **the** list. Framework-free ESM, no imports of its own,
so both sides can read it:

| reader | how |
| --- | --- |
| the browser | `src/lib/plan.ts` re-exports it. Its public API did not change — `<PlanRoute>`, the Productivity Suite, the Dashboard quick actions and `src/lib/covers.ts` were not touched. |
| the API | `lib/entitlements.mjs` answers `requireEntitlement()` from it. |
| the database | `supabase/migrations/083_server_entitlements.sql` carries the same core/non-core split into `public.plan_can_open(surface)`. |

Two lists drift, and the day they drift is the day a stranger walks into the
workshop. `scripts/_verify-entitlements.mjs` compares all three on every PR.

Each surface carries an `enforcement` block saying how the **server** holds it
shut:

```js
enforcement: {
  endpoints: ['api/meeting-chat.mjs', …],   // call requireEntitlement() with this id
  tables:    ['argument_prep_sessions', …], // INSERT fenced by 083
  exempt:    'core-open' | 'public-by-design' | 'front-end-only',
  note:      'why the line above is true',
}
```

The harness does not take the declaration on trust. A named endpoint must
really contain that call with that surface's id; a named table must really be
fenced in 083. **A frozen or beta surface that declares none of the three fails
CI.** That is the whole point of the field.

---

## The endpoint gate

```js
const gate = await requireEntitlement(userId, 'connect', { bearer: userToken });
if (!gate.ok) return sendEntitlementRefusal(res, gate);
```

- The tier is read **from the database**, never from the request. The caller's
  token only names which row to read, and migration 062 makes `pricing_tier`
  writable by the service role alone.
- A **core** surface short-circuits with no round trip: every plan may open it,
  so there is nothing to ask and the core product pays no latency.
- `workshop` passes everything. A beta surface passes exactly the plans
  `plan.ts` shows it to, because both call the same `canOpenSurfaceId()`.

### What a failure means

| situation | answer |
| --- | --- |
| tier read, not entitled | **403** — "This room is not part of your plan." |
| no `profiles` row yet (a fresh signup) | **403** — an absent row reads as `free`, the same settling `AuthContext` does |
| the read failed twice (5xx, timeout, network) | **503** — "Contextspaces could not check your plan just now. Try again in a moment." |

The 503 is the important one. Failing closed would be right for a paid
product — except that when the read fails we cannot know *whose* account it
was, and a hard refusal would shut Eden out of his own workshop. So an
unreadable plan is treated as an outage and not as a demotion: one retry
first, because the commonest failure on a cold serverless instance is a single
dropped connection, and then a 503 that promises trying again may work. No
paying account is ever told it has been downgraded by a database hiccup.

This is deliberately **stricter** than `lib/usage-meter.mjs`, which fails OPEN.
A request the meter let through costs cents and is recoverable; a room the gate
let through is not.

### Where the gates are

| surface | endpoint(s) | note |
| --- | --- | --- |
| Connect | `api/meeting-chat.mjs`, `api/meeting-flag.mjs`, `api/deepgram-token.mjs` | gated immediately after `getUser()` |
| Student Hub | `api/student-hub-ocr.mjs`, `api/student-hub-invite.mjs` | same |
| Mediation | `api/mediation.mjs` | gated where a mediation **begins** (`cases.create`, `join`). A case already on foot has another human being on the far side of it, so it is allowed to finish. `api/mediation-webhook.mjs` is called by Stripe, not by a person, and is not gated. |
| Agents | `api/assistant.mjs` | gated only when the turn names a `charterId`. This endpoint also serves the core Assistant, which every plan gets, so the gate is keyed on the charter. It can only narrow — omitting `charterId` buys the plain Assistant, never an agent. |

---

## The database gate, for modules with no endpoint

Moot Bench, Agents and the Student Hub run on `/api/llm`, which **cannot** be
gated on the feature label the browser sends: a label in a request body is a
thing anyone can type. So the lock goes where the browser cannot reach it — the
INSERT that starts the work.

Migration 083 adds one RESTRICTIVE INSERT policy per table:

| table | surface |
| --- | --- |
| `argument_prep_sessions` | Moot Bench |
| `agent_charters` | Agents |
| `student_hub_texts` | Student Hub |
| `student_hub_sessions` | Student Hub |
| `student_hub_groups` | Student Hub |

RESTRICTIVE, so it is ANDed with each table's existing owner policy rather than
replacing it: the original rule keeps working, a prod policy that has drifted
from this folder is not flattened, and re-running 083 is a no-op.

`public.plan_can_open(surface)` is **SECURITY INVOKER plpgsql** that captures
`auth.uid()` into its own variable at entry — the house rule from
`feedback_rls_security_invoker_wrappers` and migration 022. A SECURITY DEFINER
SQL function called from a WITH CHECK returns an inconsistent `auth.uid()` in
this project, and the visible symptom is `INSERT … RETURNING` failing with
42501 for a perfectly entitled user (the serverspace bug of 2026-08-13).

**SELECT, UPDATE and DELETE are untouched.** Nobody loses work they have
already done; the gate is on beginning something new, which is the only thing a
plan can honestly decide.

### Apply order

083 and the code have **no dependency in either direction** —
`lib/entitlements.mjs` reads `profiles` directly and calls nothing in 083 — so
either order is safe. **Paste 083 first**, so the database half is shut at the
moment of the merge rather than after it.

---

## The Student Hub invitation cap

An unclaimed seat could be re-invited without limit: the owner check and the
seat check both pass every time while the seat stays unclaimed, so one seat was
an unmetered, un-rate-limited mail button aimed at an address of the caller's
choosing.

`public.student_hub_invite_charge(group, email, sender)` counts and records in
one transaction (Vercel has no shared memory, so two instances would both read
"none sent yet"): **3 per seat** and **20 per owner** in a rolling 24 hours,
`service_role` only. The handler charges *before* the mail goes out, so a
Resend failure consumes one of the three — the safe direction, because the
other one lets a failing provider be retried without limit.

While the function is **not deployed** the send goes through with a loud log;
once it exists, any error refuses. That is `consumeIpUsage`'s rule in
`lib/usage-meter.mjs`, verbatim.

---

## Adding a surface

1. Add it to `SURFACES` in `lib/surfaces.mjs` with its tier, paths **and an
   `enforcement` block**.
2. Add the key to `lib/surfaces.d.mts`.
3. If it is frozen or beta, give it a real lock:
   - it has an endpoint → call `requireEntitlement(uid, '<id>')` right after
     the handler authenticates, and answer with `sendEntitlementRefusal()`;
   - it has no endpoint → fence its root table in the next migration and add
     the surface id to `plan_can_open`'s lists (between the marker comments —
     the harness reads them).
4. Run `node scripts/_verify-entitlements.mjs`. If you skipped step 3 and did
   not write down why, it is already red.
