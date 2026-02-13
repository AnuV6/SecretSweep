// ===== State =====
let currentSource = 'local';
let scanResults = null;

// ===== Severity Style Maps (inline styles — light theme) =====
const SEVERITY_STYLES = {
    critical: {
        badge: 'background: rgba(220,38,38,0.08); color: #dc2626; border: 1px solid rgba(220,38,38,0.2); font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 700; text-transform: uppercase; font-family: "JetBrains Mono", monospace;',
        badgeSquare: 'width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; background: #dc2626; color: white; font-size: 10px; font-weight: 700; font-family: "JetBrains Mono", monospace;',
    },
    high: {
        badge: 'background: rgba(234,88,12,0.08); color: #ea580c; border: 1px solid rgba(234,88,12,0.2); font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 700; text-transform: uppercase; font-family: "JetBrains Mono", monospace;',
        badgeSquare: 'width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; background: #ea580c; color: white; font-size: 10px; font-weight: 700; font-family: "JetBrains Mono", monospace;',
    },
    medium: {
        badge: 'background: rgba(202,138,4,0.08); color: #ca8a04; border: 1px solid rgba(202,138,4,0.2); font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 700; text-transform: uppercase; font-family: "JetBrains Mono", monospace;',
        badgeSquare: 'width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; background: #ca8a04; color: white; font-size: 10px; font-weight: 700; font-family: "JetBrains Mono", monospace;',
    },
    low: {
        badge: 'background: rgba(37,99,235,0.08); color: #2563eb; border: 1px solid rgba(37,99,235,0.2); font-size: 10px; padding: 2px 8px; border-radius: 4px; font-weight: 700; text-transform: uppercase; font-family: "JetBrains Mono", monospace;',
        badgeSquare: 'width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 4px; background: #2563eb; color: white; font-size: 10px; font-weight: 700; font-family: "JetBrains Mono", monospace;',
    }
};

const ARROW_COLORS = { critical: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#2563eb' };

// ===== DOM =====
const sourceTabs = document.getElementById('sourceTabs');
const scanForm = document.getElementById('scanForm');
const scanBtn = document.getElementById('scanBtn');
const scanBtnText = document.getElementById('scanBtnText');
const progressSection = document.getElementById('progressSection');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const progressFiles = document.getElementById('progressFiles');
const progressFindings = document.getElementById('progressFindings');
const summarySection = document.getElementById('summarySection');
const resultsSection = document.getElementById('resultsSection');
const resultsContainer = document.getElementById('resultsContainer');
const emptySection = document.getElementById('emptySection');
const exportBtn = document.getElementById('exportBtn');
const severityFilter = document.getElementById('severityFilter');
const ruleCount = document.getElementById('ruleCount');

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    loadRuleCount();
    setupTabs();
    setupForm();
    setupExport();
    setupFilter();
});

async function loadRuleCount() {
    try {
        const res = await fetch('/api/health');
        const data = await res.json();
        ruleCount.textContent = `${data.rules} detection rules active`;
    } catch { }
}

// ===== Tab Switching =====
function setupTabs() {
    sourceTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.source-tab');
        if (!tab) return;

        document.querySelectorAll('.source-tab').forEach(t => {
            t.classList.remove('border-primary', 'text-primary');
            t.classList.add('border-transparent', 'text-text-muted');
        });
        tab.classList.remove('border-transparent', 'text-text-muted');
        tab.classList.add('border-primary', 'text-primary');

        currentSource = tab.dataset.source;

        document.getElementById('localFields').classList.toggle('hidden', currentSource !== 'local');
        document.getElementById('githubFields').classList.toggle('hidden', currentSource !== 'github');
        document.getElementById('azureFields').classList.toggle('hidden', currentSource !== 'azure-devops');
    });
}

// ===== Form Submit =====
function setupForm() {
    scanForm.addEventListener('submit', (e) => {
        e.preventDefault();
        startScan();
    });
}

function startScan() {
    const params = new URLSearchParams();
    params.set('source', currentSource);

    if (currentSource === 'local') {
        const localPath = document.getElementById('localPath').value.trim();
        if (!localPath) return alert('Please enter a project directory path');
        params.set('path', localPath);

    } else if (currentSource === 'github') {
        const repoUrl = document.getElementById('githubUrl').value.trim();
        if (!repoUrl) return alert('Please enter a GitHub repository URL');
        params.set('repoUrl', repoUrl);
        const pat = document.getElementById('githubPat').value.trim();
        if (pat) params.set('pat', pat);

    } else if (currentSource === 'azure-devops') {
        const org = document.getElementById('azureOrg').value.trim();
        const project = document.getElementById('azureProject').value.trim();
        const repo = document.getElementById('azureRepo').value.trim();
        const pat = document.getElementById('azurePat').value.trim();
        if (!org || !project || !repo || !pat) {
            return alert('Please fill in all Azure DevOps fields');
        }
        params.set('org', org);
        params.set('project', project);
        params.set('repo', repo);
        params.set('pat', pat);
    }

    // Reset UI
    scanBtn.disabled = true;
    scanBtnText.textContent = 'SCANNING...';
    progressSection.classList.remove('hidden');
    summarySection.classList.add('hidden');
    resultsSection.classList.add('hidden');
    emptySection.classList.add('hidden');
    resultsContainer.innerHTML = '';
    progressBar.style.width = '0%';
    progressText.textContent = 'Initializing scan...';
    progressFiles.textContent = '';
    progressFindings.textContent = '';

    const eventSource = new EventSource(`/api/scan-stream?${params.toString()}`);

    eventSource.addEventListener('progress', (e) => {
        const data = JSON.parse(e.data);
        progressText.textContent = data.message;

        if (data.totalFiles && data.scanned) {
            const pct = Math.round((data.scanned / data.totalFiles) * 100);
            progressBar.style.width = pct + '%';
            progressFiles.textContent = `${data.scanned} / ${data.totalFiles} files`;
        }

        if (data.findingsCount !== undefined) {
            progressFindings.textContent = `${data.findingsCount} findings`;
        }
    });

    eventSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);
        scanResults = data;
        eventSource.close();
        showResults(data);
        resetScanButton();
    });

    eventSource.addEventListener('error', (e) => {
        if (e.data) {
            const data = JSON.parse(e.data);
            alert('Scan error: ' + data.message);
        }
        eventSource.close();
        resetScanButton();
        progressSection.classList.add('hidden');
    });

    eventSource.onerror = () => {
        eventSource.close();
        resetScanButton();
    };
}

function resetScanButton() {
    scanBtn.disabled = false;
    scanBtnText.textContent = 'START SCAN';
}

// ===== Show Results =====
function showResults(data) {
    progressSection.classList.add('hidden');

    const { summary, grouped } = data;

    document.getElementById('totalFindings').textContent = summary.totalFindings;
    document.getElementById('criticalCount').textContent = summary.critical;
    document.getElementById('highCount').textContent = summary.high;
    document.getElementById('mediumCount').textContent = summary.medium;
    document.getElementById('lowCount').textContent = summary.low;
    document.getElementById('filesScanned').textContent = `${summary.totalFiles} files scanned`;
    summarySection.classList.remove('hidden');

    if (summary.totalFindings === 0) {
        emptySection.classList.remove('hidden');
        return;
    }

    resultsSection.classList.remove('hidden');
    renderGroupedResults(grouped, 'all');
}

function renderGroupedResults(grouped, filterLevel) {
    resultsContainer.innerHTML = '';

    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

    const sortedFiles = Object.keys(grouped).sort((a, b) => {
        const aMax = Math.min(...grouped[a].map(f => severityOrder[f.severity]));
        const bMax = Math.min(...grouped[b].map(f => severityOrder[f.severity]));
        return aMax - bMax;
    });

    for (const file of sortedFiles) {
        let findings = grouped[file];

        if (filterLevel !== 'all') {
            const threshold = severityOrder[filterLevel];
            findings = findings.filter(f => severityOrder[f.severity] <= threshold);
        }
        if (findings.length === 0) continue;

        const counts = { critical: 0, high: 0, medium: 0, low: 0 };
        findings.forEach(f => counts[f.severity]++);

        const highestSev = ['critical', 'high', 'medium', 'low'].find(s => counts[s] > 0);
        const arrowColor = ARROW_COLORS[highestSev] || '#999';

        // Build severity count badges
        let badges = '';
        for (const sev of ['critical', 'high', 'medium', 'low']) {
            if (counts[sev] > 0) {
                badges += `<span style="${SEVERITY_STYLES[sev].badgeSquare}">${counts[sev]}</span> `;
            }
        }

        // Build findings HTML
        let findingsHtml = findings.map(f => {
            const s = SEVERITY_STYLES[f.severity];
            return `
        <div style="padding: 20px 24px; border-top: 1px solid #e0e0d8;">
          <div style="display: flex; gap: 16px; align-items: flex-start;">
            <div style="margin-top: 2px;">
              <span style="${s.badge}">${f.severity}</span>
            </div>
            <div style="flex: 1; min-width: 0;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div>
                  <div style="font-size: 14px; font-weight: 700; color: #111111;">${escapeHtml(f.ruleName)}</div>
                  <div style="font-size: 12px; color: #777; margin-top: 2px;">${escapeHtml(f.description)}</div>
                </div>
                <div style="font-size: 12px; color: #999; font-family: 'JetBrains Mono', monospace; flex-shrink: 0; margin-left: 12px;">Line ${f.line}</div>
              </div>
              <div style="background: #111111; border: 1px solid #222; border-radius: 8px; padding: 12px 16px; overflow-x: auto;">
                <pre style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #d4d4d4; line-height: 1.6; margin: 0; white-space: pre-wrap; word-break: break-all;">${escapeHtml(f.lineContent)}</pre>
              </div>
            </div>
          </div>
        </div>
      `;
        }).join('');

        // File group container
        const group = document.createElement('div');
        group.style.cssText = 'background: #ffffff; border: 1px solid #e0e0d8; border-radius: 12px; overflow: hidden; margin-bottom: 12px; transition: border-color 0.2s;';

        group.innerHTML = `
      <div class="file-header" style="padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background 0.15s;" onmouseover="this.style.background='#fafaf8'" onmouseout="this.style.background='#ffffff'">
        <div style="display: flex; align-items: center; gap: 14px; min-width: 0;">
          <span class="material-icons arrow-icon" style="color: ${arrowColor}; transition: transform 0.2s; font-size: 20px;">keyboard_arrow_right</span>
          <span class="material-icons" style="color: #999; font-size: 20px;">description</span>
          <div style="min-width: 0;">
            <div style="font-size: 13px; font-weight: 600; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(file)}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
          ${badges}
        </div>
      </div>
      <div class="file-findings-content" style="display: none; background: #fafaf8;">
        ${findingsHtml}
      </div>
    `;

        // Toggle expand/collapse
        const header = group.querySelector('.file-header');
        const content = group.querySelector('.file-findings-content');
        const arrow = group.querySelector('.arrow-icon');

        header.addEventListener('click', () => {
            const isOpen = content.style.display !== 'none';
            content.style.display = isOpen ? 'none' : 'block';
            arrow.textContent = isOpen ? 'keyboard_arrow_right' : 'keyboard_arrow_down';
            group.style.borderColor = isOpen ? '#e0e0d8' : '#111111';
        });

        resultsContainer.appendChild(group);
    }
}

// ===== Filter =====
function setupFilter() {
    severityFilter.addEventListener('change', () => {
        if (!scanResults || !scanResults.grouped) return;
        renderGroupedResults(scanResults.grouped, severityFilter.value);
    });
}

// ===== Export =====
function setupExport() {
    exportBtn.addEventListener('click', () => {
        if (!scanResults) return;

        const report = {
            tool: 'SecretSweep',
            timestamp: new Date().toISOString(),
            summary: scanResults.summary,
            findings: scanResults.findings
        };

        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `secretsweep-report-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });
}

// ===== Helpers =====
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
