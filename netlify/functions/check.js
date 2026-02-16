const dns = require('dns').promises;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { domain } = JSON.parse(event.body);

    if (!domain || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}$/.test(domain)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid domain format' }),
      };
    }

    const cleanDomain = domain.toLowerCase().trim();

    // Run all checks in parallel
    const [spf, dmarc, dkim, mx, blacklists] = await Promise.all([
      checkSPF(cleanDomain),
      checkDMARC(cleanDomain),
      checkDKIM(cleanDomain),
      checkMX(cleanDomain),
      checkBlacklists(cleanDomain),
    ]);

    // Calculate overall score
    const checks = [spf, dmarc, dkim, mx, blacklists];
    const score = calculateScore(checks);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        domain: cleanDomain,
        score,
        checks: { spf, dmarc, dkim, mx, blacklists },
      }),
    };
  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

// ===== SPF CHECK =====
async function checkSPF(domain) {
  try {
    const records = await dns.resolveTxt(domain);
    const flat = records.map(r => r.join('')).filter(r => r.startsWith('v=spf1'));

    if (flat.length === 0) {
      return {
        name: 'SPF Record',
        status: 'fail',
        summary: 'No SPF record found',
        detail: 'Without SPF, receiving servers cannot verify which mail servers are authorized to send email for your domain. This significantly increases the chance of your emails being flagged as spam.',
        fix: 'Add a TXT record to your DNS: v=spf1 include:_spf.google.com ~all (adjust for your email provider).',
      };
    }

    if (flat.length > 1) {
      return {
        name: 'SPF Record',
        status: 'warn',
        summary: 'Multiple SPF records found',
        detail: `Found ${flat.length} SPF records. Having more than one SPF record is invalid per RFC 7208 and may cause authentication failures.`,
        fix: 'Merge all SPF records into a single TXT record.',
        raw: flat,
      };
    }

    const spf = flat[0];

    // Check for common issues
    if (spf.includes('+all')) {
      return {
        name: 'SPF Record',
        status: 'warn',
        summary: 'SPF record is too permissive (+all)',
        detail: 'Your SPF record ends with +all, which means ANY server is authorized to send as your domain. This defeats the purpose of SPF.',
        fix: 'Change +all to ~all (softfail) or -all (hardfail).',
        raw: [spf],
      };
    }

    // Count lookups (max 10 allowed)
    const lookupKeywords = ['include:', 'a:', 'mx:', 'ptr:', 'redirect='];
    const lookupCount = lookupKeywords.reduce((c, k) => c + (spf.split(k).length - 1), 0);

    if (lookupCount > 10) {
      return {
        name: 'SPF Record',
        status: 'warn',
        summary: `SPF record has too many lookups (${lookupCount}/10)`,
        detail: 'SPF allows a maximum of 10 DNS lookups. Exceeding this causes SPF to fail silently, which hurts deliverability.',
        fix: 'Flatten your SPF record by replacing include: directives with direct IP ranges where possible.',
        raw: [spf],
      };
    }

    return {
      name: 'SPF Record',
      status: 'pass',
      summary: 'SPF record configured correctly',
      detail: `Found valid SPF record with ${lookupCount} DNS lookups (max 10). ${spf.includes('-all') ? 'Hardfail (-all) policy is set — strictest protection.' : 'Softfail (~all) policy is set — good baseline.'}`,
      raw: [spf],
    };
  } catch (err) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      return {
        name: 'SPF Record',
        status: 'fail',
        summary: 'No SPF record found',
        detail: 'Could not find any TXT records for this domain. This means email authentication is completely missing.',
        fix: 'Add a TXT record with your SPF policy. Consult your email provider for the correct include: directive.',
      };
    }
    return { name: 'SPF Record', status: 'error', summary: 'Could not check SPF', detail: err.message };
  }
}

// ===== DMARC CHECK =====
async function checkDMARC(domain) {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    const flat = records.map(r => r.join('')).filter(r => r.startsWith('v=DMARC1'));

    if (flat.length === 0) {
      return {
        name: 'DMARC Record',
        status: 'fail',
        summary: 'No DMARC record found',
        detail: 'DMARC tells receiving servers what to do when SPF or DKIM checks fail. Without it, your domain is vulnerable to spoofing and your deliverability suffers. Google and Yahoo now require DMARC for bulk senders.',
        fix: 'Add a TXT record at _dmarc.yourdomain.com: v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com',
      };
    }

    const dmarc = flat[0];
    const policyMatch = dmarc.match(/;\s*p=(\w+)/);
    const policy = policyMatch ? policyMatch[1] : 'none';
    const hasRua = dmarc.includes('rua=');

    if (policy === 'none') {
      return {
        name: 'DMARC Record',
        status: 'warn',
        summary: 'DMARC policy set to "none" (monitoring only)',
        detail: `Your DMARC record exists but the policy is set to "none", which means failed emails are still delivered. This is fine for initial monitoring, but won't protect your domain reputation long-term.${hasRua ? ' Reporting (rua) is configured — good.' : ' No reporting address (rua) configured.'}`,
        fix: 'Once you\'ve confirmed legitimate mail is passing, upgrade to p=quarantine or p=reject.',
        raw: [dmarc],
      };
    }

    if (policy === 'quarantine') {
      return {
        name: 'DMARC Record',
        status: 'pass',
        summary: 'DMARC set to quarantine — good protection',
        detail: `Emails failing authentication will be sent to spam. ${hasRua ? 'Reporting is active.' : 'Consider adding a rua= address for monitoring.'}`,
        raw: [dmarc],
      };
    }

    if (policy === 'reject') {
      return {
        name: 'DMARC Record',
        status: 'pass',
        summary: 'DMARC set to reject — strongest protection',
        detail: `Emails failing authentication will be rejected entirely. This is the gold standard. ${hasRua ? 'Reporting is active.' : 'Consider adding a rua= address to monitor rejected mail.'}`,
        raw: [dmarc],
      };
    }

    return {
      name: 'DMARC Record',
      status: 'pass',
      summary: `DMARC record found with policy: ${policy}`,
      detail: dmarc,
      raw: [dmarc],
    };
  } catch (err) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      return {
        name: 'DMARC Record',
        status: 'fail',
        summary: 'No DMARC record found',
        detail: 'DMARC is now required by Google and Yahoo for bulk senders (5,000+ emails/day). Even below that threshold, missing DMARC significantly hurts inbox placement.',
        fix: 'Add a TXT record at _dmarc.yourdomain.com with at minimum: v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com',
      };
    }
    return { name: 'DMARC Record', status: 'error', summary: 'Could not check DMARC', detail: err.message };
  }
}

// ===== DKIM CHECK =====
async function checkDKIM(domain) {
  // DKIM selectors are not standardized — we check the most common ones
  const commonSelectors = [
    'google', 'default', 'selector1', 'selector2', 'k1', 'k2',
    'mail', 'dkim', 's1', 's2', 'smtp', 'mandrill', 'mailjet',
    'amazonses', 'cm', 'zendesk1', 'zendesk2', 'everlytickey1', 'everlytickey2',
    'sig1', 'mxvault',
  ];

  const found = [];

  await Promise.all(
    commonSelectors.map(async (selector) => {
      try {
        const records = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
        const flat = records.map(r => r.join(''));
        if (flat.some(r => r.includes('v=DKIM1') || r.includes('p='))) {
          found.push({ selector, record: flat[0].substring(0, 120) + '...' });
        }
      } catch {
        // Selector not found — expected for most
      }
    })
  );

  if (found.length === 0) {
    return {
      name: 'DKIM Records',
      status: 'warn',
      summary: 'No DKIM records found for common selectors',
      detail: 'DKIM signing could not be verified using common selectors (google, default, selector1, selector2, etc.). DKIM may still be configured with a custom selector. However, if DKIM is truly missing, your emails lack cryptographic authentication.',
      fix: 'Enable DKIM signing through your email provider. For Google Workspace: Admin Console → Apps → Google Workspace → Gmail → Authenticate email. For Microsoft 365: Defender portal → Email authentication.',
    };
  }

  return {
    name: 'DKIM Records',
    status: 'pass',
    summary: `DKIM configured (${found.length} selector${found.length > 1 ? 's' : ''} found: ${found.map(f => f.selector).join(', ')})`,
    detail: `DKIM provides cryptographic authentication for your emails, proving they haven't been tampered with in transit. Found active selector${found.length > 1 ? 's' : ''}: ${found.map(f => f.selector).join(', ')}.`,
    raw: found,
  };
}

// ===== MX CHECK =====
async function checkMX(domain) {
  try {
    const records = await dns.resolveMx(domain);

    if (!records || records.length === 0) {
      return {
        name: 'Mail Server (MX)',
        status: 'fail',
        summary: 'No MX records found',
        detail: 'This domain has no mail exchange records, meaning it cannot receive email. This is a critical issue for any domain used for business communication.',
        fix: 'Configure MX records pointing to your email provider.',
      };
    }

    // Sort by priority
    records.sort((a, b) => a.priority - b.priority);
    const primary = records[0].exchange.toLowerCase();

    // Detect provider
    let provider = 'Unknown';
    let providerNote = '';

    if (primary.includes('google') || primary.includes('gmail')) {
      provider = 'Google Workspace';
      providerNote = 'Google Workspace is a solid choice for cold outbound with proper warm-up.';
    } else if (primary.includes('outlook') || primary.includes('microsoft')) {
      provider = 'Microsoft 365';
      providerNote = 'Microsoft 365 works well for outbound, especially with Outlook-to-Outlook sending.';
    } else if (primary.includes('zoho')) {
      provider = 'Zoho Mail';
      providerNote = 'Zoho is functional but has lower sending reputation than Google/Microsoft for cold outbound.';
    } else if (primary.includes('protonmail') || primary.includes('proton')) {
      provider = 'ProtonMail';
      providerNote = 'ProtonMail prioritizes privacy but is limited for cold outbound campaigns.';
    } else if (primary.includes('mimecast')) {
      provider = 'Mimecast';
      providerNote = 'Mimecast provides email security and filtering.';
    } else if (primary.includes('barracuda')) {
      provider = 'Barracuda';
      providerNote = 'Barracuda is primarily an email security gateway.';
    } else if (primary.includes('pphosted') || primary.includes('proofpoint')) {
      provider = 'Proofpoint';
      providerNote = 'Proofpoint is an enterprise email security platform.';
    }

    return {
      name: 'Mail Server (MX)',
      status: 'pass',
      summary: `${provider} detected (${records.length} MX record${records.length > 1 ? 's' : ''})`,
      detail: `Primary mail server: ${primary} (priority ${records[0].priority}). ${providerNote}`,
      raw: records.map(r => `${r.priority} ${r.exchange}`),
    };
  } catch (err) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
      return {
        name: 'Mail Server (MX)',
        status: 'fail',
        summary: 'No MX records found',
        detail: 'This domain does not appear to have mail service configured.',
        fix: 'Add MX records for your email provider.',
      };
    }
    return { name: 'Mail Server (MX)', status: 'error', summary: 'Could not check MX records', detail: err.message };
  }
}

// ===== BLACKLIST CHECK =====
async function checkBlacklists(domain) {
  // Check against common DNS-based blacklists via A record lookup
  const blacklists = [
    { name: 'Spamhaus DBL', zone: 'dbl.spamhaus.org' },
    { name: 'SURBL', zone: 'multi.surbl.org' },
    { name: 'URIBL', zone: 'multi.uribl.com' },
    { name: 'Spamcop', zone: 'bl.spamcop.net' },
    { name: 'Barracuda', zone: 'b.barracudacentral.org' },
  ];

  const listed = [];
  const clean = [];

  await Promise.all(
    blacklists.map(async (bl) => {
      try {
        await dns.resolve4(`${domain}.${bl.zone}`);
        // If it resolves, the domain is listed
        listed.push(bl.name);
      } catch {
        // NXDOMAIN = not listed (good)
        clean.push(bl.name);
      }
    })
  );

  if (listed.length > 0) {
    return {
      name: 'Blacklist Check',
      status: 'fail',
      summary: `Listed on ${listed.length} blacklist${listed.length > 1 ? 's' : ''}: ${listed.join(', ')}`,
      detail: `Your domain was found on: ${listed.join(', ')}. Being blacklisted severely impacts deliverability — most major email providers check these lists. Emails may be silently dropped or sent straight to spam.`,
      fix: 'Visit each blacklist\'s website to check your listing status and follow their delisting procedures. Also audit your sending practices — blacklisting usually indicates a history of spam complaints or poor list hygiene.',
      raw: { listed, clean },
    };
  }

  return {
    name: 'Blacklist Check',
    status: 'pass',
    summary: `Not listed on ${clean.length} major blacklists`,
    detail: `Checked against: ${clean.join(', ')}. Your domain is clean on all checked blacklists.`,
    raw: { listed, clean },
  };
}

// ===== SCORING =====
function calculateScore(checks) {
  let total = 0;
  const weights = {
    'SPF Record': 25,
    'DMARC Record': 30,
    'DKIM Records': 20,
    'Mail Server (MX)': 10,
    'Blacklist Check': 15,
  };

  for (const check of checks) {
    const weight = weights[check.name] || 20;
    if (check.status === 'pass') total += weight;
    else if (check.status === 'warn') total += weight * 0.5;
    // fail and error = 0
  }

  return Math.round(total);
}
