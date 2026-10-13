# Security Policy

Thank you for helping keep **Hearth** and its users secure. We appreciate
responsible vulnerability reports and will work with security researchers to
investigate and address valid issues.

For deployment and operational guidance, see [Secure your instance](docs/guides/security.md).

## Supported Versions

Security updates are provided for the latest stable Hearth release.

| Version               | Supported |
| --------------------- | :-------: |
| Latest stable release |    ✅     |
| Older releases        |    ❌     |

Security fixes are released in the latest stable release and may not be
backported. Keep your instance up to date using the [update guide](docs/operations/updating.md).

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, pull requests, or other public channels.**

### GitHub Private Vulnerability Reporting

The preferred reporting method is
[GitHub Private Vulnerability Reporting](https://github.com/nota9x/hearth/security/advisories/new):

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Provide the vulnerability details and submit the report.

This allows the vulnerability to be discussed and resolved privately through GitHub.

### Email

If you cannot use GitHub Private Vulnerability Reporting, email
**[a9x@is.perish.ing](mailto:a9x@is.perish.ing)**.

Please include `Hearth` and `vulnerability` in the subject line. For example:

`Hearth vulnerability: Unauthorized access to private images`

## What to Include

Please provide enough information for us to understand and reproduce the issue.
When possible, include:

- A description of the vulnerability and its potential impact.
- The affected Hearth version, commit, or branch.
- Steps to reproduce the vulnerability.
- A minimal proof of concept, if applicable, using synthetic images and test accounts.
- Any configuration required to reproduce the issue, with secrets removed.
- Suggested mitigations or fixes, if known.

Do not include live account keys, Authorization headers, cookies, `.sxcu` files,
deletion URLs, or private images belonging to others. If you are unsure whether an
issue has security implications, report it privately and we will evaluate it.

## Scope

This policy covers security vulnerabilities caused by code or configuration
provided by **Hearth**, including the web application, shared core, delivery and
maintenance Workers, database migrations, and build and deployment tooling.

Vulnerabilities that exist solely within third-party platforms, services,
dependencies, or hosting providers should generally be reported to the affected
third party instead. Dependency vulnerabilities that create an exploitable
security issue specifically in Hearth are still appropriate to report.

Active public image links intentionally require no viewer login. Report failures
of the documented access controls, such as access to private images or continued
delivery after an account or delivery domain is disabled. See the
[security guide](docs/guides/security.md) for the intended sharing and storage boundaries.

## What to Expect

We aim to acknowledge security reports within **48 hours or 2 business days**.

After acknowledgment, we will investigate the report and may contact you for
additional information. If the vulnerability is confirmed, we will work toward a
fix and determine the affected versions and appropriate disclosure process.

Resolution time depends on the severity and complexity of the issue, so we cannot
guarantee a specific remediation timeframe.

If you report a vulnerability by email and have not received an acknowledgment
within **7 days**, please follow up at
**[security@a9x.pro](mailto:security@a9x.pro)**.

## Coordinated Disclosure

Please keep vulnerability details confidential while we investigate and address
the issue.

Once a fix is available, we may publish a **GitHub Security Advisory**, release
notes, or another security notice describing the vulnerability and affected
versions.

We will coordinate public disclosure with the reporter when appropriate and are
happy to provide credit unless the reporter prefers to remain anonymous.

## Responsible Research and Safe Harbor

We consider good-faith security research conducted in accordance with this policy
to be authorized, within the limits of our authority to grant permission.

When conducting security research:

- Test on your own Hearth instance or an instance whose operator has explicitly
  authorized your testing. Use synthetic images and test accounts.
- Make a good-faith effort to avoid harming users, data, or services.
- Access only the minimum data necessary to demonstrate a vulnerability.
- Do not intentionally access, modify, retain, or disclose data belonging to others.
- Do not perform denial-of-service, social-engineering, phishing, or other
  disruptive attacks.
- Stop testing and contact us if you unexpectedly encounter sensitive data or
  cause unintended impact.

For research conducted in good faith and consistent with this policy, we will not
initiate legal action against you for the research.

This authorization applies only to systems and software for which we have the
authority to grant permission. It does not authorize testing of independently
operated Hearth instances, Cloudflare services, or other third-party infrastructure
without the relevant operator's permission, and cannot bind those operators.
