import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  sharedProductionInfo, requestShareCode, openSharedProduction, type SharedProductionInfo, type SharedVolumeDownload,
} from '@/lib/production-share';

// /p/<token> — the page a production link opens (migration 115). No account:
// the link itself, and whatever its maker asked for (an emailed code, a
// password), are the only keys. Plain on purpose: opposing counsel should be
// able to find the Download button without being told where it is.

export default function SharedProduction() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<SharedProductionInfo | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codeNote, setCodeNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // A production in volumes: every volume's link, handed out by one open.
  const [volumeLinks, setVolumeLinks] = useState<SharedVolumeDownload[] | null>(null);

  useEffect(() => {
    document.title = 'A production sent to you · Equazia.ai';
    sharedProductionInfo(token).then(setInfo).catch((e: Error) => setFatal(e.message));
  }, [token]);

  const askCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await requestShareCode(token, email);
      setCodeNote(out.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The code could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await openSharedProduction(token, {
        ...(info?.needs.email_code ? { email, code } : {}),
        ...(info?.needs.password ? { password } : {}),
      });
      if (out.volumes && out.volumes.length > 1) {
        setVolumeLinks(out.volumes);
      } else {
        setDone(out.filename);
        window.location.assign(out.url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The download could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-md border border-[#cfc8b8] bg-white px-3 py-2 text-[15px] text-[#1c1b17] focus:outline-none focus:border-[#1f4d3a]';
  const button = 'rounded-md bg-[#1f4d3a] px-4 py-2 text-[15px] text-white disabled:opacity-40';

  return (
    <div className="min-h-screen bg-[#f6f3ec] text-[#1c1b17] flex items-start justify-center px-4 py-12" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <main className="w-full max-w-[520px] rounded-lg border border-[#e2dccd] bg-[#fffdf8] p-6 shadow-sm">
        <p className="text-[13px] uppercase tracking-wider text-[#6e6a5e]">A production sent to you</p>

        {fatal && <p className="mt-4 text-[16px]">{fatal}</p>}
        {!fatal && !info && <p className="mt-4 text-[15px] text-[#6e6a5e]">Opening…</p>}

        {info && (
          <>
            <h1 className="mt-2 text-[22px] leading-snug">{info.name}</h1>
            <dl className="mt-4 space-y-1 text-[14px]">
              {info.bates_range && (
                <div className="flex gap-2"><dt className="text-[#6e6a5e] w-28 shrink-0">Bates range</dt><dd className="font-mono text-[13px]">{info.bates_range}</dd></div>
              )}
              <div className="flex gap-2"><dt className="text-[#6e6a5e] w-28 shrink-0">File</dt><dd className="font-mono text-[13px] break-all">{info.filename}</dd></div>
              {info.package_sha256 && (
                <div className="flex gap-2"><dt className="text-[#6e6a5e] w-28 shrink-0">sha256</dt><dd className="font-mono text-[11.5px] break-all">{info.package_sha256}</dd></div>
              )}
              <div className="flex gap-2"><dt className="text-[#6e6a5e] w-28 shrink-0">Link works until</dt><dd>{new Date(info.expires_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
            </dl>

            <div className="mt-6 space-y-3">
              {info.needs.email_code && (
                <>
                  <label className="block text-[14px]">
                    Your email address
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${field} mt-1`} autoComplete="email" />
                  </label>
                  <button onClick={() => void askCode()} disabled={busy || !email.trim()} className={button}>
                    Send me a code
                  </button>
                  {codeNote && <p className="text-[14px] text-[#1f4d3a]">{codeNote}</p>}
                  <label className="block text-[14px]">
                    The six-digit code from the email
                    <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} className={`${field} mt-1 font-mono tracking-[4px]`} autoComplete="one-time-code" />
                  </label>
                </>
              )}
              {info.needs.password && (
                <label className="block text-[14px]">
                  Password
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={`${field} mt-1`} autoComplete="off" />
                </label>
              )}
              {error && <p className="text-[14px] text-[#9b2c2c]">{error}</p>}
              <button
                onClick={() => void open()}
                disabled={busy || (info.needs.email_code && (!email.trim() || code.length !== 6)) || (info.needs.password && !password)}
                className={`${button} w-full`}
              >
                {busy ? 'Starting…' : 'Download'}
              </button>
              {done && <p className="text-[14px] text-[#6e6a5e]">The download of {done} should start now. If it does not, press Download again.</p>}
              {volumeLinks && (
                <div className="space-y-2">
                  <p className="text-[14px] text-[#6e6a5e]">
                    This production comes in {volumeLinks.length} volumes. Download each one; the links work for an hour.
                  </p>
                  <ul className="space-y-1.5">
                    {volumeLinks.map((v) => (
                      <li key={v.name} className="flex items-center gap-3">
                        <a href={v.url} download={v.filename} className="text-[15px] text-[#1f4d3a] underline">{v.filename}</a>
                        <span className="text-[12.5px] text-[#6e6a5e]">{(v.bytes / 1e6).toFixed(1)} MB</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <p className="mt-6 text-[12.5px] text-[#6e6a5e]">
              The sha256 above lets you check that the file you download is the one that was sent. Every download of this link is recorded for the sender.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
