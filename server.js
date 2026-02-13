const express = require('express');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const simpleGit = require('simple-git');
const os = require('os');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load detection rules
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, 'patterns', 'rules.json'), 'utf8'));
const compiledRules = rules.map(rule => ({
    ...rule,
    regex: new RegExp(rule.pattern, 'gi')
}));

// Directories and files to skip
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
    'bin', 'obj', '.next', '.nuxt', '__pycache__', '.venv', 'venv',
    'vendor', 'packages', '.vs', '.idea', 'coverage', '.nyc_output',
    'target', '.gradle', '.maven', 'bower_components', 'jspm_packages'
]);

const SKIP_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.ogg', '.wav',
    '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.pyc', '.pyo',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.lock', '.min.js', '.min.css', '.map',
    '.DS_Store', '.db', '.sqlite', '.sqlite3'
]);

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

// ---- Scanning Engine ----

function shouldSkipFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath);
    if (SKIP_EXTENSIONS.has(ext)) return true;
    if (basename.startsWith('.') && !basename.includes('env')) return true;
    if (basename === 'package-lock.json' || basename === 'yarn.lock') return true;
    return false;
}

function walkDirectory(dirPath, files = []) {
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return files;
    }

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) {
                walkDirectory(fullPath, files);
            }
        } else if (entry.isFile()) {
            if (!shouldSkipFile(fullPath)) {
                try {
                    const stats = fs.statSync(fullPath);
                    if (stats.size <= MAX_FILE_SIZE) {
                        files.push(fullPath);
                    }
                } catch { }
            }
        }
    }
    return files;
}

// Words that indicate a line is a placeholder/example, not a real secret
const FALSE_POSITIVE_PATTERNS = [
    /\bexample\b/i, /\bsample\b/i, /\bplaceholder\b/i, /\btemplate\b/i,
    /\bdummy\b/i, /\bfake\b/i, /\btest\b/i, /\bdemo\b/i,
    /your[-_]?(?:password|secret|key|token|api|server|db|database|user|org)/i,
    /xxx+/i, /\*\*\*+/, /\.\.\./,
    /TODO/i, /FIXME/i, /HACK/i,
    /\$\{[^}]+\}/, /\{\{[^}]+\}\}/, /%[sdf]/,  // Template variables
    /<[A-Z_]+>/, // Placeholder tokens like <YOUR_KEY>
    /process\.env\./,  // Environment variable references
    /os\.environ/,
    /\bgetenv\b/i,
];

// Check if a line is likely a comment
function isComment(line) {
    const trimmed = line.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('#') ||
        trimmed.startsWith('*') || trimmed.startsWith('/*') ||
        trimmed.startsWith('<!--') || trimmed.startsWith('REM ') ||
        trimmed.startsWith('echo ');
}

// Check if a match is a false positive
function isFalsePositive(ruleId, matchedText, line, filePath) {
    // Version numbers misidentified as IPs (e.g., 10.3.0.120579)
    if (ruleId === 'private-ip') {
        const ipMatch = matchedText.match(/(\d+\.\d+\.\d+\.)(\d+)/);
        if (ipMatch && ipMatch[2].length > 3) return true;
        if (/version|ver[^a-z]|sdk|runtime|nuget|package|dotnet|assembly|scanner/i.test(line)) return true;
    }

    // Skip env-file-ref in package.json (dependency declarations, not actual dotenv usage)
    const basename = path.basename(filePath).toLowerCase();
    if (ruleId === 'env-file-ref' && (basename === 'package.json' || basename === 'package-lock.json')) return true;

    // Skip package.json dependency lines entirely (version specifiers, not secrets)
    if (basename === 'package.json') {
        // Lines like "dotenv": "~10.0.0" or "express": "^4.18.0"
        if (/^\s*"[^"]+"\s*:\s*"[\^~>=<*]?\d/.test(line)) return true;
    }

    // Check for placeholder/example patterns
    for (const pattern of FALSE_POSITIVE_PATTERNS) {
        if (pattern.test(line)) return true;
    }

    return false;
}

function scanFile(filePath, baseDir) {
    const findings = [];
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return findings;
    }

    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().length === 0) continue;
        if (isComment(line)) continue;

        for (const rule of compiledRules) {
            rule.regex.lastIndex = 0;
            const match = rule.regex.exec(line);
            if (match) {
                const matchedText = match[0];

                // Skip false positives
                if (isFalsePositive(rule.id, matchedText, line, filePath)) continue;

                // Mask the secret: show first 4 and last 4 chars
                let masked = matchedText;
                if (matchedText.length > 12) {
                    masked = matchedText.substring(0, 6) + '****' + matchedText.substring(matchedText.length - 4);
                }

                findings.push({
                    ruleId: rule.id,
                    ruleName: rule.name,
                    severity: rule.severity,
                    description: rule.description,
                    file: path.relative(baseDir, filePath).replace(/\\/g, '/'),
                    line: i + 1,
                    matched: masked,
                    lineContent: line.trim().substring(0, 200)
                });
            }
        }
    }

    return findings;
}

// ---- Temp directory management for cloned repos ----

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'secretsweep-'));
}

function cleanupTempDir(dirPath) {
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
    } catch { }
}

// ---- API Routes ----

// SSE stream scan
app.get('/api/scan-stream', async (req, res) => {
    const { source, path: scanPath, repoUrl, org, project, repo, pat } = req.query;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let dirToScan = '';
    let tempDir = null;

    try {
        // Determine scan target
        if (source === 'local') {
            dirToScan = scanPath;
            if (!dirToScan || !fs.existsSync(dirToScan)) {
                send('error', { message: 'Directory not found: ' + dirToScan });
                res.end();
                return;
            }
        } else if (source === 'github') {
            if (!repoUrl) {
                send('error', { message: 'GitHub repository URL is required' });
                res.end();
                return;
            }
            tempDir = createTempDir();
            dirToScan = tempDir;
            send('progress', { phase: 'cloning', message: 'Cloning GitHub repository...' });

            let cloneUrl = repoUrl;
            if (pat) {
                // Inject PAT into URL for private repos
                const url = new URL(repoUrl);
                cloneUrl = `https://${pat}@${url.host}${url.pathname}`;
            }

            const git = simpleGit();
            await git.clone(cloneUrl, tempDir, ['--depth', '1']);
            send('progress', { phase: 'cloned', message: 'Repository cloned successfully' });

        } else if (source === 'azure-devops') {
            if (!org || !project || !repo || !pat) {
                send('error', { message: 'Azure DevOps requires: organization URL, project, repo name, and PAT' });
                res.end();
                return;
            }
            tempDir = createTempDir();
            dirToScan = tempDir;
            send('progress', { phase: 'cloning', message: 'Cloning Azure DevOps repository...' });

            // Build Azure DevOps clone URL
            // org could be https://dev.azure.com/orgname or just orgname
            let orgUrl = org;
            if (!orgUrl.startsWith('http')) {
                orgUrl = `https://dev.azure.com/${org}`;
            }
            const cloneUrl = `${orgUrl}/${project}/_git/${repo}`;

            // Use PAT for auth
            const authedUrl = cloneUrl.replace('https://', `https://pat:${pat}@`);

            const git = simpleGit();
            await git.clone(authedUrl, tempDir, ['--depth', '1']);
            send('progress', { phase: 'cloned', message: 'Repository cloned successfully' });

        } else {
            send('error', { message: 'Invalid source type. Use: local, github, or azure-devops' });
            res.end();
            return;
        }

        // Discover files
        send('progress', { phase: 'discovering', message: 'Discovering files...' });
        const files = walkDirectory(dirToScan);
        send('progress', { phase: 'discovered', message: `Found ${files.length} files to scan`, totalFiles: files.length });

        // Scan files
        const allFindings = [];
        for (let i = 0; i < files.length; i++) {
            const findings = scanFile(files[i], dirToScan);
            allFindings.push(...findings);

            // Send progress every 50 files or on last file
            if (i % 50 === 0 || i === files.length - 1) {
                send('progress', {
                    phase: 'scanning',
                    scanned: i + 1,
                    totalFiles: files.length,
                    findingsCount: allFindings.length,
                    message: `Scanning... ${i + 1}/${files.length} files`
                });
            }
        }

        // Build summary
        const summary = {
            totalFiles: files.length,
            totalFindings: allFindings.length,
            critical: allFindings.filter(f => f.severity === 'critical').length,
            high: allFindings.filter(f => f.severity === 'high').length,
            medium: allFindings.filter(f => f.severity === 'medium').length,
            low: allFindings.filter(f => f.severity === 'low').length
        };

        // Group findings by file
        const grouped = {};
        for (const finding of allFindings) {
            if (!grouped[finding.file]) {
                grouped[finding.file] = [];
            }
            grouped[finding.file].push(finding);
        }

        send('complete', { summary, findings: allFindings, grouped });

    } catch (err) {
        send('error', { message: err.message || 'Scan failed' });
    } finally {
        if (tempDir) {
            cleanupTempDir(tempDir);
        }
        res.end();
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', rules: rules.length });
});

app.listen(PORT, () => {
    console.log(`\n  SecretSweep is running at http://localhost:${PORT}\n`);
});
