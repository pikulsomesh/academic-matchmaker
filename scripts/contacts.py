"""Email de-obfuscation and contact scraping from profile / directory pages."""

import html
import re
import unicodedata
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

# "[at]", "(at)", "{at}", "<at>", with optional inner/outer whitespace and any case.
_BRACKET_AT = re.compile(r"\s*[\[\(\{<]\s*at\s*[\]\)\}>]\s*", re.IGNORECASE)
_BRACKET_DOT = re.compile(r"\s*[\[\(\{<]\s*dot\s*[\]\)\}>]\s*", re.IGNORECASE)
_LOCAL = r"[A-Za-z0-9][A-Za-z0-9._%+-]*"
_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
# Dots inside a domain are either literal (no surrounding spaces) or a spelled-out " dot ".
_DOMAIN = rf"{_LABEL}(?:(?:\.|\s+dot\s+){_LABEL})*(?:\.|\s+dot\s+)[A-Za-z]{{2,24}}"
# Bare " at ": "firstname.lastname at university.edu". Only accepted when the right-hand
# side is a real-looking domain, so prose like "professor at MIT" is left alone.
_PLAIN_AT = re.compile(rf"\b({_LOCAL})\s+at\s+({_DOMAIN})\b", re.IGNORECASE)
_EMAIL = re.compile(rf"\b{_LOCAL}@{_LABEL}(?:\.{_LABEL})*\.[A-Za-z]{{2,24}}\b")

_PLACEHOLDER_LOCALS = {"example", "name", "firstname.lastname", "first.last", "username", "user", "email", "yourname"}
_ROLE_LOCALS = {"info", "admin", "webmaster", "office", "contact", "enquiries", "inquiries", "help",
                "support", "news", "media", "press", "admissions", "reception", "dept", "department",
                "noreply", "no-reply", "communications", "marketing", "events", "hr", "jobs", "it"}


def _collapse_domain(domain):
    return re.sub(r"\s+dot\s+", ".", domain, flags=re.IGNORECASE)


def normalize_email_text(text):
    """Rewrite obfuscated addresses in free text so that they contain a plain '@'.

    Handles [at] (at) {at} <at>, a bare ' at ' between a local part and a domain,
    and the matching [dot] (dot) {dot} / ' dot ' forms.
    """
    if not text:
        return ""
    text = html.unescape(text)
    text = _BRACKET_AT.sub("@", text)
    text = _BRACKET_DOT.sub(".", text)
    text = _PLAIN_AT.sub(lambda m: f"{m.group(1)}@{_collapse_domain(m.group(2))}", text)
    # "jane@mit dot edu" left over after a bracketed [at]
    text = re.sub(rf"@\s*({_DOMAIN})", lambda m: "@" + _collapse_domain(m.group(1)), text)
    return text


def extract_emails(text):
    """Return de-duplicated, lower-cased, plausible personal emails found in text."""
    found = []
    for match in _EMAIL.findall(normalize_email_text(text)):
        email = match.strip(".").lower()
        local = email.split("@", 1)[0]
        if local in _PLACEHOLDER_LOCALS or local in _ROLE_LOCALS:
            continue
        if email.endswith((".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")):
            continue
        if email not in found:
            found.append(email)
    return found


def registered_domain(host):
    """Crude eTLD+1: 'www.cs.ox.ac.uk' -> 'ox.ac.uk', 'eecs.mit.edu' -> 'mit.edu'."""
    if not host:
        return ""
    host = host.lower().split(":")[0].strip(".")
    if host.startswith("www."):
        host = host[4:]
    parts = host.split(".")
    if len(parts) >= 3 and parts[-2] in {"ac", "edu", "co", "com", "org", "gov", "net"} and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def email_matches_institution(email, institution_domains):
    domain = registered_domain(email.split("@", 1)[-1])
    return bool(domain) and domain in institution_domains


# --- names ----------------------------------------------------------------------------

_HONORIFICS = {"dr", "prof", "professor", "mr", "mrs", "ms", "sir", "dame", "phd", "md", "frs", "jr", "sr"}


def name_tokens(name):
    name = unicodedata.normalize("NFKD", name or "")
    name = "".join(c for c in name if not unicodedata.combining(c)).lower()
    tokens = [t for t in re.split(r"[^a-z]+", name) if t and t not in _HONORIFICS]
    return tokens


def name_key(name):
    """(first initial, last name) used to match directory entries to OpenAlex authors."""
    tokens = name_tokens(name)
    if not tokens:
        return None
    return (tokens[0][0], tokens[-1])


def email_matches_name(email, name):
    """True when the local part plausibly belongs to `name` (contains surname, or initials+surname)."""
    tokens = name_tokens(name)
    if not tokens:
        return False
    local = re.sub(r"[^a-z]", "", email.split("@", 1)[0].lower())
    last, first = tokens[-1], tokens[0]
    if len(last) >= 3 and last in local:
        return True
    if len(first) >= 3 and first in local:
        return True
    initials = "".join(t[0] for t in tokens)
    return len(initials) >= 2 and local == initials


# --- titles ---------------------------------------------------------------------------

_TITLE = re.compile(
    r"\b((?:Distinguished |Regius |University |Emeritus |Emerita |Senior |Principal |Visiting |Adjunct |Research |Clinical |Full )*"
    r"(?:Assistant |Associate )?(?:Professor|Lecturer|Reader|Fellow|Chair)"
    r"(?:\s+(?:of|in)\s+[A-Z][A-Za-z&,\- ]{2,80}?)?)(?=\s*(?:[.;|\n<]|,\s|$| at | in the ))"
)


def extract_title(text):
    """Best-effort academic title, e.g. 'Associate Professor of Chemical Engineering'."""
    if not text:
        return None
    best = None
    for m in _TITLE.finditer(text):
        candidate = re.sub(r"\s+", " ", m.group(1)).strip(" ,-")
        if "Professor" in candidate or best is None:
            if best is None or len(candidate) > len(best) or "Professor" not in best:
                best = candidate
        if best and "Professor" in best and " of " in best:
            break
    return best


# --- pages ----------------------------------------------------------------------------

def page_text_and_links(html_text, base_url):
    soup = BeautifulSoup(html_text, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()
    mailtos = []
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.lower().startswith("mailto:"):
            addr = href[7:].split("?", 1)[0]
            mailtos.append(normalize_email_text(addr))
        elif href.startswith(("http", "/")):
            links.append((urljoin(base_url, href), a.get_text(" ", strip=True)))
    text = soup.get_text("\n", strip=True)
    return text, mailtos, links, soup


def scrape_profile_page(html_text, url, name, institution_domains):
    """Pull email and title for one person from their own profile page."""
    text, mailtos, _, _ = page_text_and_links(html_text, url)
    candidates = extract_emails("\n".join(mailtos)) + extract_emails(text)
    email = None
    for addr in dict.fromkeys(candidates):
        if email_matches_name(addr, name) and (not institution_domains or email_matches_institution(addr, institution_domains)):
            email = addr
            break
    head = text[:4000]
    return {"email": email, "title": extract_title(head)}


_CARD_TAGS = ["article", "section", "div", "li", "tr", "td", "dd"]


def _element_emails(element):
    mailtos = [a["href"][7:].split("?", 1)[0] for a in element.select("a[href]") if a["href"].lower().startswith("mailto:")]
    return set(extract_emails("\n".join(mailtos) + "\n" + element.get_text("\n", strip=True)))


def _person_cards(soup):
    single = [el for el in soup.find_all(_CARD_TAGS) if len(_element_emails(el)) == 1]
    single_ids = {id(el) for el in single}
    return [el for el in single if not any(id(parent) in single_ids for parent in el.parents)]


def scrape_directory_page(html_text, url, item_selector=None):
    """Extract (name, email, profile_url, title) entries from a faculty directory page.

    With `item_selector` (CSS), each matching element is one person. Without it, a card is
    the outermost block element that contains exactly one distinct email address
    (plain, mailto, or obfuscated), which is how most directory grids are laid out.
    """
    _, _, _, soup = page_text_and_links(html_text, url)
    if item_selector:
        items = soup.select(item_selector)
    else:
        items = _person_cards(soup)
    entries = []
    for item in items:
        text = item.get_text("\n", strip=True)
        mailtos = [normalize_email_text(a["href"][7:].split("?", 1)[0]) for a in item.select("a[href]")
                   if a["href"].lower().startswith("mailto:")]
        emails = extract_emails("\n".join(mailtos) + "\n" + text)
        heading = item.find(["h2", "h3", "h4", "h5", "strong", "b"])
        name = heading.get_text(" ", strip=True) if heading else text.split("\n", 1)[0]
        profile = None
        for a in item.select("a[href]"):
            href = a["href"].strip()
            if href.lower().startswith(("mailto:", "tel:", "#", "javascript:")):
                continue
            if name_key(a.get_text(" ", strip=True)) == name_key(name) or profile is None:
                profile = urljoin(url, href)
        if not name or len(name) > 80:
            continue
        entries.append({
            "name": name,
            "email": next((e for e in emails if email_matches_name(e, name)), None),
            "profile_url": profile,
            "title": extract_title(text),
        })
    return entries


def same_site(url, institution_domains):
    try:
        return registered_domain(urlparse(url).hostname) in institution_domains
    except ValueError:
        return False
