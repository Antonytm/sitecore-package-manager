# Security Accounts in Packages

How users and roles are selected, stored, and installed. Verified against the
`security-accounts` sample and the decompiled `Sitecore.Install.Security.*`. Secondary to items
for our SitecoreAI app, but documented for completeness.

## In the definition

A single static `accounts` source ([[package-definition-xml]]) lists each account as
`type:domain\name`:

```xml
<accounts>
  <Entries>
    <x-item>roles:sitecore\Author</x-item>
    <x-item>users:sitecore\antontishchenko@gmail.com</x-item>
  </Entries>
  <Converter><AccountToEntryConverter><Transforms /></AccountToEntryConverter></Converter>
  <Name>security-accounts</Name>
</accounts>
```

## In the package

Stored under the `security/` prefix, one entry per account, path
`security/<users|roles>/<domain>/<name>`:

```
security/roles/sitecore/Author
security/users/sitecore/antontishchenko@gmail.com
```

### Role entry

Minimal — just the role's membership in other roles:

```xml
<role><membership><role>sitecore\Sitecore Client Authoring</role></membership></role>
```

### User entry

`<properties>` (ASP.NET membership) + `<profile>` (Sitecore profile). Simple values are plain
text; complex .NET types are **base64-encoded BinaryFormatter blobs** (`base64="true"`):

```xml
<user>
  <properties>
    <property name="Email">antontishchenko@gmail.com</property>
    <property name="IsApproved" base64="true">AAEAAAD/////…(System.Boolean)…</property>
    <property name="LastActivityDate" base64="true">AAEAAAD/////…(System.DateTime)…</property>
    <property name="LastLoginDate" base64="true">…</property>
  </properties>
  <profile>
    <property name="Portrait">https://s.gravatar.com/avatar/…</property>
    <property name="FullName">Anton Tishchenko</property>
    <property name="IsAdministrator" base64="true">…</property>
  </profile>
</user>
```

> The base64 values are .NET `BinaryFormatter`-serialized primitives (Boolean, DateTime, …).
> Reproducing them byte-for-byte requires emitting compatible serialization; for reading we can
> decode them, for writing we may prefer setting these via the target's security API instead.

## Installation

`Sitecore.Install.Security.AccountInstaller` handles the `security/` entries. It is **not**
registered in `Installer.CreateInstallerSink` (which only wires metadata/blob/items/files —
see [[package-installation]]); it is instantiated separately in the install flow (`new
AccountInstaller()`) and validates the leading `security` path segment before installing:

- **`InstallUser`** — parse the user XML; if the user exists, skip with a warning; else
  `User.Create(name, password)`, set profile + role memberships.
- **`InstallRole`** — `Roles.CreateRole(name)`, then wire up nested-role membership.
- **`Finish()`** — applies deferred memberships (when a parent role didn't exist yet).

## SitecoreAI implementation notes

- Out of scope for the initial items-only app. SitecoreAI/XM Cloud uses a different identity/
  security model (Sitecore Cloud / Identity), so legacy ASP.NET membership blobs don't map
  cleanly.
- If we later support it: read `security/**`, decode the membership XML, and recreate accounts
  via the target's security API — do **not** try to round-trip the base64 BinaryFormatter blobs;
  reconstruct the properties semantically (email, approved, admin, roles).

## Sources

- Sample `security-accounts-1.0.0.zip` (extracted) + `files/samples/definitions/security-accounts.xml`, 2026-06-21.
- Decompiled `Sitecore.Install.Security.AccountInstaller`, `Sitecore.Install.Security.SecuritySource`, 2026-06-21.
