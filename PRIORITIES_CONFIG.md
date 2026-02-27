# Configuring Finding Priorities

This document explains how to customize which findings are shown prominently for each repository.

## Overview

By default, the tool shows the top 3 findings for each repository, with additional findings available in a collapsible "View more issues" section. You can customize:

1. **Which findings appear in the top section** - by setting priority numbers
2. **How many findings to show** - by changing `top_findings_count`
3. **The sorting strategy** - by choosing `priority` or `severity`

## Configuration Files

The priority configuration is stored in **`priorities.json`** (or `priorities.yaml` for documentation).

### priorities.json

```json
{
  "priorities": [
    {
      "title": "Missing LICENSE",
      "priority": 1,
      "reason": "Legal clarity is essential for any open source project"
    },
    ...
  ],
  "options": {
    "top_findings_count": 3,
    "respect_optional_flag": true,
    "sort_strategy": "priority"
  }
}
```

## Priority Configuration

### Adding/Modifying Priorities

Each finding in the `priorities` array has:

- **`title`** (required): Must match the exact finding title from the analyzer
- **`priority`** (required): Lower number = higher priority (1 = shown first)
- **`reason`** (optional): Explanation for this priority
- **`optional_top_3`** (optional): If `true`, can be excluded from top 3 when inherited from org

**Example:** To make SECURITY.md less prominent:

```json
{
  "title": "Missing SECURITY.md",
  "priority": 10,
  "reason": "Important but often inherited from organization",
  "optional_top_3": true
}
```

### Options

- **`top_findings_count`** (default: 3)  
  Number of findings to show prominently before the collapsible section.
  
- **`respect_optional_flag`** (default: true)  
  When true, findings marked with `optional_top_3: true` may be moved down if they're inherited.
  
- **`sort_strategy`** (default: "priority")  
  - `"priority"`: Use the priorities list and fall back to severity
  - `"severity"`: Ignore priorities and sort by severity only (critical > important > recommended > optional)

## Common Customizations

### Show More Top Findings

Change `top_findings_count` to show 5 findings instead of 3:

```json
{
  "options": {
    "top_findings_count": 5,
    ...
  }
}
```

### Disable Priority Sorting

To use only severity-based sorting:

```json
{
  "options": {
    "sort_strategy": "severity",
    ...
  }
}
```

### Customize for Your Organization

Different organizations may have different priorities. For example:

**Security-focused organization:**
```json
{
  "priorities": [
    {"title": "Missing SECURITY.md", "priority": 1},
    {"title": "Missing LICENSE", "priority": 2},
    {"title": "Missing unit tests", "priority": 3},
    ...
  ]
}
```

**Documentation-focused organization:**
```json
{
  "priorities": [
    {"title": "Missing README baseline", "priority": 1},
    {"title": "Missing repository description", "priority": 2},
    {"title": "Missing CONTRIBUTING.md", "priority": 3},
    ...
  ]
}
```

## Finding Titles Reference

Common finding titles from the analyzer:

- `Missing LICENSE`
- `Missing README baseline`
- `Missing CONTRIBUTING.md`
- `Missing CODE_OF_CONDUCT.md`
- `Missing SECURITY.md`
- `Missing CHANGELOG.md`
- `Missing ACCESSIBILITY.md`
- `Missing SUSTAINABILITY.md`
- `Missing unit tests`
- `Missing CI/CD pipeline`
- `Missing repository description`
- `Missing repository topics`
- `Missing repository website`
- `Stale README`
- `Missing issue templates`
- `Missing pull request template`
- Outdated dependencies

**Note:** Finding titles may vary based on the analyzer configuration. Check your actual findings to see the exact titles.

## Deployment

### Local Development

Simply edit `priorities.json` and reload the page. The configuration is loaded automatically on page load.

### GitHub Pages

1. Edit `priorities.json` in your repository
2. Commit and push changes
3. GitHub Pages will deploy automatically
4. Users will see the new priorities on next page load

## Troubleshooting

### Priorities not working?

1. **Check browser console** for loading errors
2. **Verify JSON syntax** using a JSON validator
3. **Check finding titles** - they must match exactly (case-sensitive)
4. **Confirm `sort_strategy`** is set to `"priority"`

### Want to reset to defaults?

Delete `priorities.json` or set `sort_strategy` to `"severity"`.

## Example Workflow

**User feedback:** "SECURITY.md shouldn't always be in the top 3 since we have it in our org-level `.github` repo."

**Solution:**

1. Edit `priorities.json`
2. Find the SECURITY.md entry
3. Either increase its priority number (e.g., from 5 to 10) or add `"optional_top_3": true`
4. Commit and deploy

The tool will now prioritize other findings over SECURITY.md for the top 3 spots.
