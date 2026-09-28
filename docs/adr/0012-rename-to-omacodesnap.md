---
number: 0012
title: Rename Omasnap to OmaCodeSnap
status: accepted
date: 2026-09-28
---

# ADR-0012: Rename Omasnap to OmaCodeSnap

## Status

Accepted.

## Context

A separate Omarchy project called OmaSnap already exists, and it takes
screenshots. Two plugins called Omasnap and OmaSnap would be confused in the
marketplace, in the launcher and in conversation.

## Decision

The project is now OmaCodeSnap. Every live name follows:

- plugin id `com.keithrowell.omacodesnap`, manifest `name` "OmaCodeSnap"
- launcher `bin/omacodesnap` (and `~/.local/bin/omacodesnap`)
- window title and Hyprland window rule `^(OmaCodeSnap)$`
- environment variables `OMACODESNAP_*` (were `OMASNAP_*`)
- the snap-provider manifest block `omacodesnap` (was `omasnap`, ADR-0010)
- GitHub repo `keithrowell/omarchy-plugin-omacodesnap`

No compatibility aliases: the only known provider (OmaWordl) had already
dropped its integration, and the plugin had not been published.

Shipped specs and ADRs 0001–0011 keep the old name; they are the record of
what was true when they were written.

## Consequences

An existing install must be removed and reinstalled under the new id
(disable the old plugin, remove its symlink, desktop file and launcher, run
`bin/install`, enable the new id) and the Hyprland binding updated. Open
branches written against the old names need the same substitution when they
are rebased.
