# Memory and Skills

Memory stores useful facts. Skills store reviewed instructions and scripts for repeating useful work. Both are inspectable; neither should become a hidden channel for permissions or credentials.

## Memory

Open **Memory** to browse or search facts, choose private/shared scope, add or edit a fact, forget it, or import/export data. An agent searches its own private facts and shared facts, with source and event references available for traceability. Expiry, contradiction handling and derived-fact relationships help keep knowledge current.

Keep short, specific facts with a source. Prefer “Use Brazilian Portuguese for customer drafts” to pasting an entire mailbox into memory. When removing a fact, review its derived relationships as well as the original entry.

Memory text is encrypted under separate agent/shared keys derived from the instance master key. Search vectors remain available to PostgreSQL; encrypted text does not make the database devoid of sensitive metadata. Resource labels still govern where retrieved facts may go.

Ordinary memory browsing has display limits. A **person-data export** is a separate streaming operation and includes all matching stored memories, including expired ones and matches beyond the normal screen limit. See [Security and Privacy](Security-and-Privacy.md) for erasure and backup limitations.

## Skills

A skill combines `SKILL.md` instructions and optional scripts. Agents may propose skills after repeat work; humans can also add them. Review cards show contents, scans, differences and dry-run information. Inspect what the skill reads, writes, sends or spends before approving it.

Approve, edit or reject proposals in **Skills**. Version history and rollback let you return to an earlier reviewed version. New content is scanned for hidden instructions and secrets. Approved skills continue through the normal task permission system when executed.

Updating a routine's prompt or approved skill invalidates its first-run approval. Re-review the new behavior before allowing unattended runs. Avoid putting passwords or provider keys in skill files; use vault references and narrowly scoped grants.

Source: [memory service](../../apps/server/src/memory/service.ts), [memory package](../../packages/memory/src/index.ts), [skills service](../../apps/server/src/skills/service.ts), [skill scanner](../../packages/skills/src/scanner.ts).
