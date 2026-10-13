/**
 * Maintenance dashboard rendering.
 * Reads a maintenance-rollup.json (or the static sample fixture), validates
 * it against policy/rollup.schema.json, and renders five accessible
 * sections: unavailable data, urgent security, failed PRs, eligible
 * updates, and needs-review items. No network calls beyond fetching the
 * rollup file itself; no AI involved in rendering or classification.
 */

const rollupSourceSelect = document.getElementById('rollupSource');
const rollupMeta = document.getElementById('rollupMeta');
const liveStatus = document.getElementById('liveStatus');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportMarkdownBtn = document.getElementById('exportMarkdownBtn');

let currentRollup = null;
let rollupSchema = null;

async function getRollupSchema() {
    if (rollupSchema) return rollupSchema;
    const response = await fetch('policy/rollup.schema.json');
    rollupSchema = await response.json();
    return rollupSchema;
}

const sections = {
    unavailable: { section: document.getElementById('unavailableSection'), list: document.getElementById('unavailableList') },
    urgent: { section: document.getElementById('urgentSection'), list: document.getElementById('urgentList') },
    failed: { section: document.getElementById('failedSection'), list: document.getElementById('failedList') },
    eligible: { section: document.getElementById('eligibleSection'), list: document.getElementById('eligibleList') },
    review: { section: document.getElementById('reviewSection'), list: document.getElementById('reviewList') },
    openPrs: { section: document.getElementById('openPrsSection'), list: document.getElementById('openPrsBody') },
    library: { section: document.getElementById('librarySection'), list: document.getElementById('libraryList') },
};
const emptyState = document.getElementById('emptyState');

async function loadRollup(url) {
    rollupMeta.textContent = `Loading ${url}…`;
    try {
        const [response, schema] = await Promise.all([fetch(url), getRollupSchema()]);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        renderRollup(data, url, schema);
    } catch (error) {
        rollupMeta.textContent = `Could not load ${url}: ${error.message}`;
        clearSections();
        showEmptyState();
    }
}

function clearSections() {
    for (const { list } of Object.values(sections)) {
        list.innerHTML = '';
    }
    for (const { section } of Object.values(sections)) {
        section.hidden = true;
    }
}

function showEmptyState() {
    emptyState.hidden = false;
}

function hideEmptyState() {
    emptyState.hidden = true;
}

function renderRollup(rollup, sourceUrl, schema) {
    clearSections();

    if (window.PolicyValidator && schema) {
        const errors = window.PolicyValidator.validatePolicySchema(rollup, schema);
        if (errors.length > 0) {
            rollupMeta.textContent = `${sourceUrl}: schema validation failed (${errors.length} issue(s)). See console for details.`;
            console.error('Rollup schema validation errors:', errors);
            showEmptyState();
            return;
        }
    }

    currentRollup = rollup;
    hideEmptyState();

    const snapshotAge = window.PrView.describeSnapshotAge(rollup.run_timestamp, new Date());
    rollupMeta.textContent =
        `Snapshot from the scan on ${rollup.run_timestamp}${snapshotAge ? ` (${snapshotAge})` : ''} — ` +
        `policy v${rollup.policy_version}, ${rollup.repositories.length} repositor${rollup.repositories.length === 1 ? 'y' : 'ies'}. ` +
        `Everything below is as of that scan unless marked otherwise.`;
    liveStatus.textContent = '';

    const unavailableItems = [];
    const urgentItems = [];
    const failedItems = [];
    const eligibleItems = [];
    const reviewItems = [];

    for (const repo of rollup.repositories) {
        for (const [field, status] of Object.entries(repo.coverage)) {
            if (status === 'unknown' || status === 'not_available') {
                unavailableItems.push({ repo: repo.full_name, field, status });
            }
        }

        if (repo.security_alerts.has_urgent_alerts) {
            // Deliberately reading only the boolean flag here, never
            // critical/high directly: Dependabot security alerts are private
            // on GitHub even for public repos, so exact counts must never be
            // rendered on this public page. See rollup.schema.json.
            urgentItems.push({ repo: repo.full_name });
        }

        for (const pr of repo.failed_update_prs) {
            failedItems.push({ repo: repo.full_name, pr });
        }

        for (const pr of repo.dependabot_prs) {
            if (pr.risk_state === 'eligible') {
                eligibleItems.push({ repo: repo.full_name, pr });
            } else if (pr.risk_state === 'needs_review' || pr.risk_state === 'blocked') {
                reviewItems.push({ repo: repo.full_name, pr });
            }
        }
    }

    renderUnavailable(unavailableItems, rollup.repositories);
    renderUrgent(urgentItems);
    renderFailed(failedItems);
    const now = new Date();
    renderEligible(window.PrView.sortForReview(eligibleItems, now), now);
    renderReview(window.PrView.sortForReview(reviewItems, now), now);
    const openPrRows = window.PrView.reposWithOpenPrs(rollup.repositories);
    renderOpenPrs(openPrRows);
    const libraryRepos = rollup.repositories.filter((r) => r.library_advice && r.library_advice.length > 0);
    renderLibraryAdvice(libraryRepos);

    // The sample fixture names example PRs, so only live data is re-checked.
    if (sourceUrl === LIVE_ROLLUP) refreshPrStates();

    if (
        unavailableItems.length === 0 &&
        urgentItems.length === 0 &&
        failedItems.length === 0 &&
        eligibleItems.length === 0 &&
        reviewItems.length === 0 &&
        openPrRows.length === 0 &&
        libraryRepos.length === 0
    ) {
        showEmptyState();
    }
}

function renderUnavailable(items, repositories) {
    const { section, list } = sections.unavailable;
    if (items.length === 0) return;
    section.hidden = false;
    const groups = window.CoverageHelp.summarizeCoverageGaps(repositories);
    // Collapsed by default, so the count tells you whether it is worth opening
    document.getElementById('unavailableCount').textContent = `(${groups.length} gap${groups.length === 1 ? '' : 's'})`;
    for (const group of groups) {
        const li = document.createElement('li');
        li.className = 'finding-card';

        const title = document.createElement('strong');
        const statusText = group.status === 'unknown' ? 'could not be read' : 'turned off';
        const n = group.repos.length;
        title.textContent = `${group.label}: ${statusText} on ${n} repositor${n === 1 ? 'y' : 'ies'}`;
        li.appendChild(title);

        const help = document.createElement('p');
        help.textContent = group.help;
        li.appendChild(help);

        // Native disclosure: keyboard and screen-reader support built in
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `Show the ${n} repositor${n === 1 ? 'y' : 'ies'}`;
        details.appendChild(summary);
        const repoList = document.createElement('ul');
        repoList.className = 'coverage-repo-list';
        for (const repo of group.repos) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.href = `https://github.com/${repo}`;
            link.textContent = repo;
            item.appendChild(link);
            repoList.appendChild(item);
        }
        details.appendChild(repoList);
        li.appendChild(details);

        list.appendChild(li);
    }
}

function renderUrgent(items) {
    const { section, list } = sections.urgent;
    if (items.length === 0) return;
    section.hidden = false;
    for (const item of items) {
        const li = document.createElement('li');
        li.className = 'finding-card critical';

        const text = document.createElement('span');
        text.textContent = `${item.repo}: critical or high severity Dependabot alerts are open. `;
        li.appendChild(text);

        const link = document.createElement('a');
        link.href = `https://github.com/${item.repo}/security/dependabot`;
        link.textContent = 'View in GitHub Security tab';
        li.appendChild(link);

        list.appendChild(li);
    }
}

function renderFailed(items) {
    const { section, list } = sections.failed;
    if (items.length === 0) return;
    section.hidden = false;
    for (const { repo, pr } of items) {
        const li = document.createElement('li');
        li.className = 'finding-card important';
        tagPrCard(li, repo, pr);

        const title = document.createElement('strong');
        title.textContent = `${repo} — PR #${pr.number}: ${pr.dependency_name}`;
        li.appendChild(title);

        const detail = document.createElement('p');
        detail.textContent = `Failed check: ${pr.failed_check_name}. ${pr.failure_summary}`;
        li.appendChild(detail);

        const link = document.createElement('a');
        link.href = pr.url;
        link.textContent = `View PR #${pr.number}`;
        li.appendChild(link);

        list.appendChild(li);
    }
}

const LIVE_ROLLUP = 'maintenance-rollup.public.json';
const LIVE_CHECK_LIMIT = 40; // GitHub allows 60 unauthenticated requests per hour per network
const LIVE_CACHE_MS = 10 * 60 * 1000;

function tagPrCard(li, repo, pr) {
    li.dataset.repo = repo;
    li.dataset.pr = String(pr.number);
}

function readLiveCache(key) {
    try {
        const cached = JSON.parse(sessionStorage.getItem(key) || 'null');
        return cached && Date.now() - cached.at < LIVE_CACHE_MS ? cached.state : undefined;
    } catch {
        return undefined; // storage blocked or unreadable: just fetch
    }
}

function writeLiveCache(key, state) {
    try {
        sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), state }));
    } catch {
        // storage blocked: the check still works, it is only repeated
    }
}

/**
 * The scan is a snapshot; PRs are often merged soon after. Ask GitHub for
 * each listed PR's current state (public data, no sign-in) and remove the
 * ones already merged or closed, so the page never asks you to act on
 * something already done. Falls back to the snapshot on any error.
 */
async function refreshPrStates() {
    const cards = [...document.querySelectorAll('li[data-pr]')];
    const allKeys = [...new Set(cards.map((li) => `${li.dataset.repo}#${li.dataset.pr}`))];
    const keys = allKeys.slice(0, LIVE_CHECK_LIMIT);
    if (keys.length === 0) return;
    liveStatus.textContent = `Checking the current state of ${keys.length} pull request${keys.length === 1 ? '' : 's'} on GitHub…`;

    const states = new Map();
    let stoppedEarly = false;
    for (const key of keys) {
        const cacheKey = `pr-state:${key}`;
        let state = readLiveCache(cacheKey);
        if (state === undefined) {
            const [repo, number] = key.split('#');
            try {
                const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
                    headers: { Accept: 'application/vnd.github+json' },
                });
                if (response.status === 403 || response.status === 429) {
                    stoppedEarly = true; // rate limited: keep the rest as snapshot data
                    break;
                }
                state = response.ok ? window.PrView.liveStateFromApi(await response.json()) : null;
            } catch {
                state = null; // network error: leave this card as it was
            }
            writeLiveCache(cacheKey, state);
        }
        states.set(key, state);
    }

    let merged = 0;
    let closed = 0;
    for (const li of cards) {
        const state = states.get(`${li.dataset.repo}#${li.dataset.pr}`);
        if (state === 'merged' || state === 'closed') {
            if (state === 'merged') merged++; else closed++;
            const section = li.closest('section');
            li.remove();
            if (section && !section.querySelector('li[data-pr]')) section.hidden = true;
        }
    }

    const checked = states.size;
    const parts = [];
    if (merged) parts.push(`${merged} merged`);
    if (closed) parts.push(`${closed} closed`);
    let message = parts.length
        ? `Checked ${checked} pull request${checked === 1 ? '' : 's'} just now: ${parts.join(' and ')} since the scan, so removed from the lists below.`
        : `Checked ${checked} pull request${checked === 1 ? '' : 's'} just now: all still open.`;
    if (stoppedEarly) {
        message += ' GitHub\'s hourly limit for unauthenticated requests was reached, so the rest show their state as of the scan.';
    } else if (keys.length < allKeys.length) {
        message += ` Only the first ${LIVE_CHECK_LIMIT} were checked.`;
    }
    liveStatus.textContent = message;
}

function describeAge(pr, now) {
    const days = window.PrView.ageInDays(pr.opened_at, now);
    if (days === null) return 'age unknown';
    return days === 1 ? 'open 1 day' : `open ${days} days`;
}

function renderPrCard(list, className, repo, pr, now) {
    const li = document.createElement('li');
    li.className = `finding-card ${className}`;
    tagPrCard(li, repo, pr);

    const title = document.createElement('strong');
    title.textContent = `${repo} — PR #${pr.number}: ${pr.dependency_name} ${pr.version_from} → ${pr.version_to}`;
    li.appendChild(title);

    const meta = document.createElement('p');
    meta.className = 'pr-meta';
    meta.textContent = `${pr.update_type} update · ${pr.dependency_class.replace(/-/g, ' ')} · CI: ${pr.ci_status} · ${describeAge(pr, now)}`;
    li.appendChild(meta);

    const blocker = window.PrView.mergeBlocker(pr);
    const why = document.createElement('p');
    why.textContent = blocker ? `Not merging on its own: ${blocker}` : 'Nothing blocking: eligible under policy and CI is passing.';
    li.appendChild(why);

    const link = document.createElement('a');
    link.href = pr.url;
    link.textContent = `View PR #${pr.number}`;
    li.appendChild(link);

    list.appendChild(li);
}

function renderEligible(items, now) {
    const { section, list } = sections.eligible;
    if (items.length === 0) return;
    section.hidden = false;
    for (const { repo, pr } of items) renderPrCard(list, 'success', repo, pr, now);
}

function renderReview(items, now) {
    const { section, list } = sections.review;
    if (items.length === 0) return;
    section.hidden = false;
    for (const { repo, pr } of items) renderPrCard(list, 'recommended', repo, pr, now);
}

const LIBRARY_KIND_LABELS = {
    compromised: 'Compromised',
    deprecated: 'Deprecated',
    unmaintained: 'Unmaintained',
    native: 'Built-in alternative',
    lighter: 'Lighter alternative',
};

function renderLibraryAdvice(repos) {
    const { section, list } = sections.library;
    if (repos.length === 0) return;
    section.hidden = false;
    for (const repo of repos) {
        const li = document.createElement('li');
        const urgent = repo.library_advice.some((a) => a.kind === 'compromised' || a.kind === 'deprecated');
        li.className = `finding-card ${urgent ? 'important' : 'recommended'}`;

        const title = document.createElement('strong');
        const link = document.createElement('a');
        link.href = `https://github.com/${repo.full_name}`;
        link.textContent = repo.full_name;
        title.appendChild(link);
        li.appendChild(title);

        const items = document.createElement('ul');
        items.className = 'library-advice-list';
        for (const advice of repo.library_advice) {
            const item = document.createElement('li');
            const pkg = document.createElement('code');
            pkg.textContent = advice.package;
            item.append(
                `${LIBRARY_KIND_LABELS[advice.kind] || advice.kind}: `,
                pkg,
                ` (${advice.dependency_type}) — ${advice.suggestion}`,
            );
            items.appendChild(item);
        }
        li.appendChild(items);
        list.appendChild(li);
    }
}

function renderOpenPrs(rows) {
    const { section, list } = sections.openPrs;
    if (rows.length === 0) return;
    section.hidden = false;
    for (const row of rows) {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.scope = 'row';
        const link = document.createElement('a');
        link.href = `https://github.com/${row.repo}/pulls`;
        // <wbr> lets narrow screens wrap after "owner/" instead of mid-word
        const slash = row.repo.indexOf('/') + 1;
        link.append(row.repo.slice(0, slash), document.createElement('wbr'), row.repo.slice(slash));
        th.appendChild(link);
        tr.appendChild(th);
        for (const value of [row.dependabot, row.other, row.total]) {
            const td = document.createElement('td');
            td.textContent = String(value);
            tr.appendChild(td);
        }
        list.appendChild(tr);
    }
}

function exportAsJSON() {
    if (!currentRollup) return;
    const json = JSON.stringify(window.PublicRedaction.redactExactAlertCounts(currentRollup), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'maintenance-rollup-export.json';
    a.click();
    URL.revokeObjectURL(url);
}

function exportAsMarkdown() {
    if (!currentRollup) return;
    let md = `# Maintenance Rollup\n\n`;
    md += `Run: ${currentRollup.run_timestamp}  \nPolicy version: ${currentRollup.policy_version}\n\n`;
    for (const repo of currentRollup.repositories) {
        md += `## ${repo.full_name}\n\n`;
        md += `Tier: ${repo.tier}. Recommended action: **${repo.recommended_action.action}** — ${repo.recommended_action.reason}\n\n`;
        md += repo.security_alerts.has_urgent_alerts
            ? `Security alerts: critical or high severity alerts are open. See https://github.com/${repo.full_name}/security/dependabot for detail.\n\n`
            : `Security alerts: no open critical or high severity alerts reported.\n\n`;
        if (repo.dependabot_prs.length > 0) {
            md += `### Dependabot PRs\n\n`;
            for (const pr of repo.dependabot_prs) {
                md += `- [#${pr.number}](${pr.url}) ${pr.dependency_name} ${pr.version_from} → ${pr.version_to}: **${pr.risk_state}**, CI ${pr.ci_status}, ${describeAge(pr, new Date())} — ${pr.reason}\n`;
            }
            md += `\n`;
        }
        if (repo.library_advice && repo.library_advice.length > 0) {
            md += `### Library suggestions\n\n`;
            for (const a of repo.library_advice) {
                md += `- \`${a.package}\` (${a.dependency_type}) — ${LIBRARY_KIND_LABELS[a.kind] || a.kind}: ${a.suggestion}\n`;
            }
            md += `\n`;
        }
        if (repo.failed_update_prs.length > 0) {
            md += `### Failed update PRs\n\n`;
            for (const pr of repo.failed_update_prs) {
                md += `- [#${pr.number}](${pr.url}) ${pr.dependency_name}: ${pr.failed_check_name} failed — ${pr.failure_summary}\n`;
            }
            md += `\n`;
        }
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'maintenance-rollup-export.md';
    a.click();
    URL.revokeObjectURL(url);
}

rollupSourceSelect.addEventListener('change', () => {
    loadRollup(rollupSourceSelect.value);
});
exportJsonBtn.addEventListener('click', exportAsJSON);
exportMarkdownBtn.addEventListener('click', exportAsMarkdown);

/**
 * Accordion: each trigger button toggles its own panel via aria-expanded
 * and the hidden attribute. Native <button> already gives Space/Enter
 * activation and keyboard focus for free (WAI-ARIA APG disclosure
 * pattern) — no custom key handling needed.
 */
function setTriggerExpanded(trigger, expanded) {
    trigger.setAttribute('aria-expanded', String(expanded));
    const panel = document.getElementById(trigger.getAttribute('aria-controls'));
    if (panel) panel.hidden = !expanded;
}

const accordionTriggers = Array.from(document.querySelectorAll('.accordion-trigger'));
for (const trigger of accordionTriggers) {
    trigger.addEventListener('click', () => {
        const isExpanded = trigger.getAttribute('aria-expanded') === 'true';
        setTriggerExpanded(trigger, !isExpanded);
    });
}

document.getElementById('expandAllBtn').addEventListener('click', () => {
    for (const trigger of accordionTriggers) setTriggerExpanded(trigger, true);
});
document.getElementById('collapseAllBtn').addEventListener('click', () => {
    for (const trigger of accordionTriggers) setTriggerExpanded(trigger, false);
});

loadRollup(rollupSourceSelect.value);
