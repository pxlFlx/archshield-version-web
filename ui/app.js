(() => {
  const $ = (selector) => document.querySelector(selector);
  const tabs = [...document.querySelectorAll('.tab')];
  const githubPanel = $('#github-panel');
  const zipPanel = $('#zip-panel');
  const repoInput = $('#repo-url');
  const zipInput = $('#zip-file');
  const fileLabel = $('#file-label');
  const dropzone = $('#dropzone');
  const scanButton = $('#scan-button');
  const progress = $('#progress');
  const progressText = $('#progress-text');
  const errorBox = $('#error-box');
  const results = $('#results');
  let mode = 'github';
  let latestReport = null;
  let currentFilter = 'all';

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    tabs.forEach((item) => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
    githubPanel.classList.toggle('hidden', mode !== 'github');
    zipPanel.classList.toggle('hidden', mode !== 'zip');
    hideError();
  }));

  zipInput.addEventListener('change', () => updateFileLabel(zipInput.files?.[0]));
  ['dragenter', 'dragover'].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) { const transfer = new DataTransfer(); transfer.items.add(file); zipInput.files = transfer.files; updateFileLabel(file); }
  });
  function updateFileLabel(file) { fileLabel.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : 'Drop a ZIP here or browse files'; }

  scanButton.addEventListener('click', runScan);
  $('#new-scan').addEventListener('click', () => { results.classList.add('hidden'); $('#scan-title').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('#export-report').addEventListener('click', () => {
    if (!latestReport) return;
    const blob = new Blob([JSON.stringify(latestReport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${safeFilename(latestReport.project)}-archshield-report.json`; anchor.click(); URL.revokeObjectURL(url);
  });
  document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
    currentFilter = button.dataset.filter; document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button));
    if (latestReport) renderFindings(latestReport.findings || []);
  }));

  async function runScan() {
    hideError();
    let request;
    if (mode === 'github') {
      const repository = repoInput.value.trim();
      if (!repository) return showError('Enter a public GitHub repository URL first.');
      request = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository }) };
    } else {
      const file = zipInput.files?.[0];
      if (!file) return showError('Choose a ZIP archive first.');
      if (!file.name.toLowerCase().endsWith('.zip')) return showError('Please select a .zip archive.');
      if (file.size > 4 * 1024 * 1024) return showError('The ZIP must be 4 MB or smaller.');
      request = { headers: { 'Content-Type': 'application/zip' }, body: file };
    }
    setBusy(true);
    progressText.textContent = mode === 'github' ? 'Fetching the public repository…' : 'Uploading and checking the ZIP archive…';
    try {
      const response = await fetch('/api/scan', { method: 'POST', ...request });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Scan failed (HTTP ${response.status}).`);
      latestReport = payload;
      renderReport(payload);
      results.classList.remove('hidden');
      results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      showError(error instanceof Error ? error.message : 'The scan failed. Please try again.');
    } finally { setBusy(false); }
  }

  function renderReport(report) {
    $('#result-project').textContent = report.project || 'Project results';
    $('#result-meta').textContent = `${report.source || 'Project'} · scanned ${new Date().toLocaleString()}`;
    $('#metric-files').textContent = number(report.analyzedFiles);
    $('#metric-local').textContent = number(report.dependencies?.local);
    $('#metric-errors').textContent = number(report.summary?.errors);
    $('#metric-warnings').textContent = number(report.summary?.warnings);
    $('#metric-external').textContent = number(report.dependencies?.external);
    $('#metric-duration').textContent = `${number(report.durationMs)} ms`;
    $('#metric-config').textContent = report.configuration === 'repository' ? 'Repository' : 'Default rules';
    $('#metric-version').textContent = report.tool?.version || '—';
    const notice = $('#config-notice');
    if (report.notice) { notice.textContent = report.notice; notice.classList.remove('hidden'); } else notice.classList.add('hidden');
    renderFindings(report.findings || []);
    renderDiagnostics(report.diagnostics || []);
  }

  function renderFindings(findings) {
    const filtered = currentFilter === 'all' ? findings : findings.filter((item) => item.severity === currentFilter);
    $('#finding-count').textContent = String(filtered.length);
    const list = $('#findings-list'); list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state';
      const strong = document.createElement('strong'); strong.textContent = findings.length ? 'No findings in this filter.' : 'No architecture violations found.';
      const copy = document.createElement('span'); copy.textContent = findings.length ? 'Choose another severity to see more results.' : 'The configured rules did not detect any violations in this scan.';
      empty.append(strong, copy); list.append(empty); return;
    }
    filtered.forEach((finding) => {
      const article = document.createElement('article'); article.className = 'finding';
      const top = document.createElement('div'); top.className = 'finding-top';
      const badge = document.createElement('span'); badge.className = `severity ${finding.severity}`; badge.textContent = String(finding.severity || 'info').toUpperCase();
      const rule = document.createElement('span'); rule.className = 'rule-id'; rule.textContent = finding.ruleId || 'architecture-rule'; top.append(badge, rule);
      const title = document.createElement('h4'); title.textContent = finding.title || finding.message || 'Architecture finding';
      const message = document.createElement('p'); message.textContent = finding.message || '';
      const location = document.createElement('div'); location.className = 'location'; location.textContent = `${finding.importer || 'unknown'}:${finding.line || 1}:${finding.column || 1}`;
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Why it matters & suggested fix';
      const explanation = document.createElement('p'); explanation.textContent = `Why it matters: ${finding.explanation || 'Review this dependency.'}`;
      const remediation = document.createElement('p'); remediation.textContent = `Suggested fix: ${finding.remediation || 'Review the dependency direction and project rules.'}`;
      details.append(summary, explanation, remediation); article.append(top, title, message, location, details); list.append(article);
    });
  }

  function renderDiagnostics(items) {
    const list = $('#diagnostics-list'); list.replaceChildren();
    if (!items.length) { list.textContent = 'No diagnostics reported.'; return; }
    items.slice(0, 12).forEach((item) => {
      const row = document.createElement('div'); row.className = 'diagnostic';
      const code = document.createElement('strong'); code.textContent = `${String(item.level || 'info').toUpperCase()} · ${item.code || 'NOTICE'}`;
      const message = document.createElement('span'); message.textContent = item.message || '';
      row.append(code, message); list.append(row);
    });
    if (items.length > 12) { const extra = document.createElement('p'); extra.textContent = `And ${items.length - 12} more diagnostics.`; list.append(extra); }
  }

  function setBusy(busy) { scanButton.disabled = busy; scanButton.querySelector('span:first-child').textContent = busy ? 'Scanning project…' : 'Run architecture scan'; progress.classList.toggle('hidden', !busy); }
  function showError(message) { errorBox.textContent = message; errorBox.classList.remove('hidden'); }
  function hideError() { errorBox.classList.add('hidden'); errorBox.textContent = ''; }
  function number(value) { return new Intl.NumberFormat().format(Number(value) || 0); }
  function formatBytes(value) { return `${(value / 1024 / 1024).toFixed(2)} MB`; }
  function safeFilename(value) { return String(value || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'; }
})();
