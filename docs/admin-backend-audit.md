# Audit Admin → Backend → WhatsApp

**Verdict:** Același motor pentru salon + stomatologie e OK dacă fiecare tenant are număr WhatsApp propriu și catalog/ore din Admin — nu din default-uri de frizerie.

**Stare (15 Aug 2026):** Fix-urile din secțiunea „Gap-uri” de mai jos sunt **livrate** pe `main` (catalog gol la business nou, UI `business_info` + meniu, triage pe catalog, `businessId` obligatoriu la draft-uri).

---

## Răspuns scurt

Panoul de Admin scrie `businesses` / `services` / `employees`; botul citește live de acolo. Nu există un al doilea catalog secret pentru ore sau prețuri. Riscul de încurcare e operațional (același număr Twilio, catalog greșit) — nu amestec automat între doi tenanți configurați corect.

---

## 1. Fluxul de date

| Intrare | Cod | Rol |
|--------|-----|-----|
| WhatsApp To (Twilio) | `getBusinessByWhatsAppToNumber` | Alege tenantul după numărul afacerii |
| businesses + services | `withServices` / `loadBusinessContext` | Catalog, ore, contact, calendar |
| employees | `listEmployees` / `resolveEmployeeCalendarId` | Calendar pe angajat |
| conversation_states | `(business_id, client_phone)` | Memorie sesiune izolată pe tenant |
| draft_bookings | `business_id` la lookup/update | Programări pending / confirmate |
| calendar_cache + Google | `business_id` (+ `employee_id`) | Disponibilitate reală |
| Admin UI → API | `upsertBusinessAdmin` | Scrie aceeași sursă pe care botul o citește |

---

## 2. Ce scrie Admin și ce citește botul

| Setare | Unde se salvează | Unde citește botul | Status |
|--------|------------------|--------------------|--------|
| Servicii | Tabel `services` (+ oglindă JSON) | `withServices` → `getBookingConfig` | Live |
| Program ore | `booking_settings.business_hours` | `getConfiguredBusinessHours` | Live; fără ore = închis |
| Contact / maps | `booking_settings.contact` | `contactService` | Live |
| Fapte AI (text) | `booking_settings.ai_facts` | `businessInfoLookup` / AI | Live |
| Parcare / femei / copii | `booking_settings.business_info` | `businessInfoLookup` | Live + **UI Admin dedicat** |
| Menu buttons | `businesses.menu_buttons` | `menuHandler` | Live + **UI Admin etichete** |
| Twilio / WhatsApp ID | coloane + bridge JSON | webhook routing | Izolarea tenantului |
| Google Calendar | business + employee | `googleCalendarService` | Live |
| Prompt / conversation_logic | coloane + settings | `aiContextLoader` | Fresh per request |
| Slot / orizont / buffer / TTL | `booking_settings` | `getBookingConfig` | Live |

Fișiere cheie: `public/admin.js`, `src/db/adminService.js`, `src/utils/datetime.js`, `src/utils/businessInfoLookup.js`, `src/services/aiContextLoader.js`.

---

## 3. Dubluri (încă relevante)

| Problemă | Unde | Impact |
|----------|------|--------|
| Servicii dual | `services` table + `booking_settings.services` | Tabelul câștigă; JSON = oglindă / fallback |
| Ore UI vs live | Admin prefill L–V vs `ALL_CLOSED` | Live nu inventează ore; primul Save poate persista default-ul de ore |
| `contact.hours` string | fallback în contact | Form-ul Admin nu colectează; orele reale = `business_hours` |

### Rezolvate prin fix-uri

- Default frizerie la business nou → **catalog gol**
- Alias/triage global tuns/barbă → **doar dacă apare în catalogul tenantului** (`mentionsCatalogVocabulary`)
- `business_info` / menu fără UI → **câmpuri în Admin**
- Draft update pe `draftId` fără `businessId` → **refuzat fără `businessId`**

---

## 4. Izolare multi-tenant

| Zonă | Status | Notă |
|------|--------|------|
| conversation_states / drafts / cache | OK | Filtrate pe `business_id` |
| Helpers draft (service/slot/confirm/cancel) | OK (după fix) | `businessId` obligatoriu |
| RLS Supabase | Bypass | Node folosește `service_role`; izolarea e în aplicație |
| Cache transport WhatsApp To | Mic risc | Poate servi tenant cached dacă DB lookup eșuează |

**Nu se amestecă dacă:** număr Twilio To distinct, sesiune pe `(business_id, telefon)`, calendar corect per tenant.

**Se strică dacă:** același număr WhatsApp pe două business-uri, sau catalog/ore greșite pe tenant.

---

## 5. Checklist onboarding (salon + stomatologie)

1. Număr Twilio/WhatsApp unic (To)
2. Adaugă serviciile reale (catalogul nou e gol — nu mai vine Tuns by default)
3. Setează `business_hours` pe fiecare zi
4. Contact + `maps_url`
5. `google_calendar_id` (+ angajați) + Mock Mode OFF pe live
6. `ai_facts` și/sau flags parcare/femei/copii din Admin
7. `business_type`: booking vs consulting
8. Welcome / confirmare / terms / gdpr dacă le vrei pe live

---

## SMS opt-in (bază clienți)

| Canal | Cum |
|-------|-----|
| WhatsApp automat | La **confirmarea programării** clientul intră în opt-in SMS |
| WhatsApp manual | Clientul scrie `da sms` / `stop sms` |
| Admin manual | Secțiunea SMS → „Bază opt-in manuală” (adaugă / scoate numere) |

Welcome WhatsApp include consimțământul GDPR la începutul conversației. După programare, nota GDPR menționează și SMS + `stop sms`.

