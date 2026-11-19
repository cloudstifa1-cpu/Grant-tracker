// GrantKeep — Phase 6: document vault on each grant (award letters, receipts,
// reports, contracts). Files are private: only your team can open them, and each
// open uses a link that stops working after 2 minutes.

export const BUCKET = 'grant-docs';
const MAX_MB = 25;
export const KINDS = { award_letter: 'Award letter', receipt: 'Receipt', report: 'Report', contract: 'Contract', other: 'Other' };

const size = (b) => (b == null ? '' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
const fileName = (d) => d.name || d.file_path.split('/').pop().replace(/^[0-9a-f-]{36}-/, '');
const safe = (s) => s.normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_').slice(-100) || 'file';

export async function mountGrantDocuments(el, g, h) {
  const { sb, esc, toast, friendlyError, fetchAll, canEdit, fmtDate, confirmTap } = h;
  const edit = canEdit();

  async function render() {
    let docs;
    try {
      docs = await fetchAll(() => sb.from('documents').select('*').eq('grant_id', g.id).order('created_at', { ascending: false }));
    } catch (e) {
      el.innerHTML = `<div class="alert">Couldn't load documents: ${esc(friendlyError(e))}</div>`; return;
    }
    el.innerHTML = `
      ${docs.length ? `<div class="card"><ul class="list">${docs.map((d) => `
        <li>
          <div class="row"><b>${esc(fileName(d))}</b><span class="tag">${esc(KINDS[d.kind] || 'Other')}</span></div>
          <div class="small">${fmtDate(d.created_at.slice(0, 10))}${d.size_bytes ? ` · ${size(d.size_bytes)}` : ''}</div>
          <div class="actions">
            <button class="btn small" data-open="${d.id}">Open</button>
            ${edit ? `<button class="btn danger small" data-del-doc="${d.id}">Delete</button>` : ''}
          </div>
        </li>`).join('')}</ul></div>`
      : '<div class="note">No documents yet. Keep the award letter, receipts and past reports here so anyone on the team can find them.</div>'}
      ${edit ? `
      <form id="f-doc" class="card">
        <h3>Add a document</h3>
        <label>File (up to ${MAX_MB} MB)<input type="file" name="file" required></label>
        <label>What is it?<select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <button class="btn" type="submit">Upload</button>
      </form>` : ''}`;

    el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
      const d = docs.find((x) => x.id === b.dataset.open);
      // Open the tab first (phones block pop-ups opened after waiting), then send it to the file.
      const tab = window.open('', '_blank');
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(d.file_path, 120, { download: fileName(d) });
      if (error) { tab?.close(); return toast(`Couldn't open it: ${friendlyError(error)}`, true); }
      if (tab) tab.location.href = data.signedUrl; else location.href = data.signedUrl;
    }));

    el.querySelectorAll('[data-del-doc]').forEach((b) => b.addEventListener('click', () => confirmTap(b, async () => {
      const d = docs.find((x) => x.id === b.dataset.delDoc);
      const { error } = await sb.from('documents').delete().eq('id', d.id);
      if (error) return toast(friendlyError(error), true);
      const { error: e2 } = await sb.storage.from(BUCKET).remove([d.file_path]);
      if (e2) console.warn('File left in storage:', e2.message);
      toast('Document deleted'); render();
    }, 'Tap again to delete')));

    const form = el.querySelector('#f-doc');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = form.file.files[0];
      if (!file) return toast('Pick a file first.', true);
      if (file.size > MAX_MB * 1048576) return toast(`That file is over ${MAX_MB} MB.`, true);
      const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Uploading…';
      const path = `${g.org_id}/${g.id}/${crypto.randomUUID()}-${safe(file.name)}`;
      try {
        const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' });
        if (up.error) throw up.error;
        const { error } = await sb.from('documents').insert({
          org_id: g.org_id, grant_id: g.id, file_path: path, kind: form.kind.value,
          name: file.name.slice(0, 200), size_bytes: file.size, uploaded_by: h.state.member.id,
        });
        if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }
        toast('Uploaded'); render();
      } catch (err) {
        console.error(err);
        const m = friendlyError(err);
        toast(/bucket not found/i.test(m) ? 'File storage isn\'t set up yet. Run supabase/phase6.sql first.' : `Upload failed: ${m}`, true);
        btn.disabled = false; btn.textContent = 'Upload';
      }
    });
  }
  render();
}
