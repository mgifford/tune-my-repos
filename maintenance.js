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

    rollupMeta.textContent =
        `Loaded ${sourceUrl} — run ${rollup.run_timestamp}, policy v${rollup.policy_version}, ` +
        `${rollup.repositories.length} repositor${rollup.repositories.length === 1 ? 'y' : 'ies'}.`;

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

    renderUnavailable(unavailableItems);
    renderUrgent(urgentItems);
    renderFailed(failedItems);
    renderEligible(eligibleItems);
    renderReview(reviewItems);

    if (
        unavailableItems.length === 0 &&
        urgentItems.length === 0 &&
        failedItems.length === 0 &&
        eligibleItems.length === 0 &&
        reviewItems.length === 0
    ) {
        showEmptyState();
    }
}

function renderUnavailable(items) {
    const { section, list } = sections.unavailable;
    if (items.length === 0) return;
    section.hidden = false;
    for (const item of items) {
        const li = document.createElement('li');
        li.className = 'finding-card';
        li.textContent = `${item.repo}: ${item.field.replace(/_/g, ' ')} is ${item.status.replace(/_/g, ' ')}`;
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

function renderEligible(items) {
    const { section, list } = sections.eligible;
    if (items.length === 0) return;
    section.hidden = false;
    for (const { repo, pr } of items) {
        const li = document.createElement('li');
        li.className = 'finding-card success';
        li.textContent = `${repo} — PR #${pr.number}: ${pr.dependency_name} ${pr.version_from} → ${pr.version_to} (${pr.update_type}). ${pr.reason}`;
        list.appendChild(li);
    }
}

function renderReview(items) {
    const { section, list } = sections.review;
    if (items.length === 0) return;
    section.hidden = false;
    for (const { repo, pr } of items) {
        const li = document.createElement('li');
        li.className = 'finding-card recommended';
        li.textContent = `${repo} — PR #${pr.number}: ${pr.dependency_name} ${pr.version_from} → ${pr.version_to} (${pr.update_type}, ${pr.risk_state}). ${pr.reason}`;
        list.appendChild(li);
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
                md += `- [#${pr.number}](${pr.url}) ${pr.dependency_name} ${pr.version_from} → ${pr.version_to}: **${pr.risk_state}** — ${pr.reason}\n`;
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

loadRollup(rollupSourceSelect.value);
