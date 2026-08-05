# Predlog: administracija naloga u handoverApp

Status: predlog za odluku
Autor: pripremljeno za vlasnika sistema
Verzija: 1.0

---

## 1. Cilj

Uvesti pojam **korisnika** u handoverApp i ekran na kome ovlašćena osoba:

- dodaje nove korisnike i daje im pristup,
- gasi pristup postojećim,
- dodeljuje i oduzima admin prava,
- vidi ko se i kada prijavljivao i sa kog uređaja, i može taj uređaj da odjavi.

**Šta ovaj predlog namerno ne dira:** tok za stanare. Link sa `?t=` tokenom,
`requireMatchingInspection` i `requireMatchingRole` ostaju netaknuti. Stanari
nemaju naloge i ne treba da ih imaju — svaki pokušaj da se i oni uvuku u model
korisnika udvostručio bi obim posla bez ijedne koristi.

---

## 2. Zašto je ovo potrebno

Trenutno stanje (`gas/Authservice.gs`) nema pojam osobe. Postoji samo uloga
`admin` i lista nonce-ova u Script Properties. Praktične posledice:

| Pitanje | Trenutni odgovor |
|---|---|
| Ko je izmenio ovu inspekciju? | `admin:Dušan main device` — slobodan tekst iz tokena, ne zapis o osobi |
| Kako da damo pristup novom kolegi? | Otvoriti Apps Script editor, izmeniti konstantu `LABEL`, pokrenuti funkciju, prekopirati token iz loga, poslati ga nekako |
| Kako da oduzmemo pristup? | Otvoriti editor, pokrenuti `listAdminTokens()`, naći nonce, pokrenuti `revokeAdminTokenByNonce()` |
| Ko ima pristup upravo sada? | Samo iz editora |
| Kome je token istekao? | Za 365 dana od izdavanja, bez upozorenja |

Sve to znači da pristup sistemu može da menja samo osoba koja ume da uđe u
Apps Script editor — a to je isti nivo pristupa kao i mogućnost da promeni ceo
backend. Nema srednjeg nivoa: ili si programer, ili ne možeš da administriraš
naloge.

---

## 3. Ključna odluka: čime se korisnik prijavljuje

Tri realne opcije.

| | A — Lozinka (model iz Spesena) | B — Email + jednokratni kod | C — Google Sign-In |
|---|---|---|---|
| Baza kredencijala | `PassHash` + `Salt` u tabeli | **nema je** | nema je |
| Kvalitet hash-a | Apps Script nema bcrypt/scrypt/PBKDF2; ostaje brzi SHA — slaba odbrana ako iko dobije pristup tabeli | nije primenljivo | nije primenljivo |
| Početni kredencijal | šalje se nešifrovanim mejlom | nema ga | nema ga |
| "Zaboravio sam lozinku" | poseban tok koji treba napisati | **ne postoji kao pojam** | Google to rešava |
| Radi za spoljne saradnike | da | da | samo uz Google nalog |
| Drugi faktor | ne | slabo (posed mejla) | da, besplatno od Google-a |
| Koliko novog koda | najviše | srednje | najmanje |

### Preporuka: **opcija B — email + jednokratni šestocifreni kod**

Obrazloženje:

1. **Nema baze lozinki koju treba čuvati.** Apps Script nema pravu funkciju za
   izvođenje ključa; `Utilities.computeDigest` je brz SHA-256, što znači da bi
   lista hash-eva u Sheetsu bila slabo zaštićena od offline probijanja. Model
   bez lozinke tu klasu problema uklanja, ne ublažava.
2. **Ne postoji trenutak u kome kredencijal putuje nešifrovanom poštom kao
   trajna vrednost.** Spesenov `README.md` to i navodi kao poznatu slabost svog
   modela. Kod jednokratnog koda mejlom ide vrednost koja važi 10 minuta i
   troši se pri prvoj upotrebi.
3. **Ceo niz ekrana i tokova jednostavno ne postoji:** postavljanje početne
   lozinke, promena lozinke, reset lozinke, politika složenosti, prisilna
   rotacija. To je otprilike polovina posla u opciji A.
4. **Aktivacija i gašenje su inherentni.** Ako red korisnika nije `active`, kod
   se ne šalje i prijava ne postoji. Nema stanja u kome je nalog ugašen a
   kredencijal još radi.
5. **Ponovo se koristi ono što već postoji.** HMAC potpisivanje, `Utils.safeEqual`,
   provera `exp`, opoziv preko nonce-a — sve je već napisano i radi u
   `Authservice.gs`. Menja se sadržaj payload-a, ne mehanizam.

**Cena koju treba svesno prihvatiti:** svaka nova prijava traži mejl. Rešava se
tokenom uređaja (tačka 5) — sesija traje 12 sati, uređaj se pamti 60 dana. U
praksi korisnik unosi kod jednom u dva meseca.

**Kada bih ipak izabrao A:** ako je dosledan model prijave u obe aplikacije
(Spesen i handoverApp) važniji od gornjih pet tačaka — jedan način rada, jedna
procedura podrške, jedno objašnjenje korisnicima. To je legitiman argument i
odluka je tvoja; tehnički je B bolji.

**Kada bih izabrao C:** ako su svi sadašnji i budući korisnici na Google
Workspace-u firme. Tada je najmanje koda, a MFA dobijaš besplatno. Ograničenje
je što svaki budući spoljni saradnik mora imati Google nalog.

Ostatak dokumenta pisan je za opciju B. Model podataka i ceo ekran za
administraciju identični su i za C — menja se samo korak provere kredencijala.

---

## 4. Model podataka

Dva nova lista u postojećoj radnoj svesci, uklopljena u `SheetService.COLUMNS`.

### List `Users`

| Kolona | Opis |
|---|---|
| `userId` | `USR-YYYY-NNNNNN`, isti obrazac kao `generateInspectionId()` |
| `email` | mala slova, **jedinstven** — prirodni ključ |
| `name` | ime i prezime, ide u audit i u PDF |
| `role` | `admin` \| `inspector` |
| `status` | `active` \| `disabled` |
| `createdAt` / `createdBy` | ko je i kada otvorio nalog |
| `disabledAt` / `disabledBy` | ko je i kada ugasio |
| `lastLoginAt` | poslednja uspešna prijava |
| `notes` | slobodan tekst za admina |

Namerno **samo dva statusa**. Treće stanje ("pozvan", "još nije postavio
lozinku") ne postoji jer nema šta da se postavlja — oznaka *još se nije
prijavio* izvodi se iz praznog `lastLoginAt` i prikazuje kao badge. Jedno
stanje manje znači jedan prelaz manje koji može da se pokvari.

### List `Devices`

| Kolona | Opis |
|---|---|
| `deviceId` | `DEV-YYYY-NNNNNN` |
| `userId` | vlasnik |
| `label` | "iPhone Safari", predlaže se automatski iz User-Agenta, korisnik može da promeni |
| `nonce` | vrednost za opoziv; menja se samo brisanjem uređaja |
| `createdAt` / `lastSeenAt` | za prikaz "poslednji put korišćen pre 3 dana" |
| `expiresAt` | 60 dana od kreiranja |
| `revokedAt` / `revokedBy` | ko je i kada odjavio uređaj |
| `userAgent` | pun string, za prepoznavanje sumnjivog uređaja |

Ovaj list **zamenjuje** `ADMIN_NONCES` iz Script Properties. Ista uloga, ali
vidljiva u UI, vezana za osobu i sa istorijom.

### Jednokratni kodovi — **ne u tabelu**

Kod se čuva u `CacheService.getScriptCache()`, ključ `otp:<sha256(email)>`,
vrednost `{codeHash, expiresAt, attempts}`, TTL 600 sekundi. Razlozi: sam se
briše (nema čišćenja), ne ostavlja trag u trajnom skladištu, i ne može da se
pročita iz tabele. U tabelu ide samo audit zapis da je kod tražen — ne i sam kod.

### Audit — postojeći list `AuditLog`

Nema novog lista. `AuditLog` već ima `eventId`, `inspectionId`, `actor`,
`eventType`, `timestamp`, `detailsJson`. Za događaje vezane za naloge
`inspectionId` ostaje prazan, a dodaju se tipovi:

```
login_code_requested   login_succeeded      login_failed
user_created           user_disabled        user_enabled
role_granted           role_revoked
device_registered      device_revoked
```

`actor` postaje `user:ime.prezime@firma.rs` umesto `admin:<8 znakova tokena>`.
Time svaki postojeći zapis u inspekcijama dobija pravo ime osobe.

---

## 5. Model tokena

Tri tipa, svi u postojećem formatu `base64url(payload).hmac`:

| Tip | Payload | Trajanje |
|---|---|---|
| Sesija | `{typ:'s', uid, did, exp, nonce}` | 12 sati |
| Uređaj | `{typ:'d', uid, did, exp, nonce}` | 60 dana |
| Stanar | `{iid, role:'tenant', exp, nonce}` | **nepromenjeno** |

### Najvažnije pravilo celog predloga

> **Uloga se ne nalazi u tokenu.** Token nosi identitet (`uid`), a ovlašćenje se
> čita iz reda u listu `Users` pri svakom zahtevu.

Bez ovog pravila ekran za administraciju ne ispunjava ono što obećava. Ako bi
`role` stajala u potpisanom tokenu, "oduzeo sam mu admin prava" značilo bi
"prestaće da bude admin za 12 sati" — a to nije ono što administrator misli da
je uradio kada klikne dugme. Isto važi i za gašenje naloga.

### Provera na svaki zahtev

Nadogradnja `AuthService.verifyToken()`:

1. HMAC potpis i `exp` — postojeći kod, nepromenjen
2. `did` → red u `Devices`: postoji, `revokedAt` prazan, `nonce` se poklapa, nije istekao
3. `uid` → red u `Users`: `status === 'active'`
4. `authCtx.role` = `role` iz tog reda, `authCtx.email`, `authCtx.name`, `authCtx.actorString = 'user:' + email`

Koraci 2 i 3 su dva dodatna čitanja iz Sheetsa po API pozivu. Rešava se
`CacheService` keširanjem po ključevima `u:<uid>` i `d:<did>` sa TTL 60
sekundi, koje se **briše pri svakoj izmeni** korisnika ili uređaja. Isti
obrazac već postoji u `Config.gs` (keš od 30 sekundi), pa je dosledno.

**Kompromis koji treba prihvatiti:** promena uloge ili gašenje naloga stupaju na
snagu u roku od 60 sekundi, ne trenutno. Ako je i to previše, TTL za `Users` se
spusti na nulu uz cenu jednog čitanja po zahtevu. Preporuka je 60 sekundi, uz
to što gašenje naloga **odmah** opoziva sve uređaje te osobe — pa ugašeni
korisnik u najgorem slučaju ima još jedan minut pristupa sa uređaja koji je već
bio prijavljen, i nijednu mogućnost nove prijave.

---

## 6. Tok prijave

```
1. Ekran /login  →  polje "Email"  →  [Pošalji kod]

2. requestLoginCode(email)                          [javna akcija]
   ├─ korisnik ne postoji ILI status != active
   │    → vrati ISTI odgovor kao za uspeh, ne šalji ništa
   │      (postojanje naloga se ne otkriva)
   └─ korisnik aktivan
        → 6 cifara izvedenih iz Utilities.getUuid()
        → sha256(kod + uid + TOKEN_SECRET) u keš, 10 min
        → MailApp.sendEmail

3. Ekran traži: kod  +  [x] Zapamti ovaj uređaj  +  naziv uređaja

4. redeemLoginCode(email, code, deviceLabel, remember)   [javna akcija]
   ├─ najviše 5 pokušaja po kodu, pa se kod poništava
   └─ uspeh → red u Devices
             → { sessionToken, deviceToken?, user:{name,email,role} }
             → upiši lastLoginAt, zapiši login_succeeded

5. Frontend čuva tokene u localStorage (isto mesto gde je sada admin token)

6. Istek sesije:  ima deviceToken → refreshSession() tiho, bez mejla
                  nema         → nazad na korak 1
```

Dve javne akcije zahtevaju izmenu u `Code.gs`, koji trenutno poziva
`resolveAuth` pre svakog dispatch-a (linija 30). Uvodi se lista
`PUBLIC_ACTIONS = ['requestLoginCode', 'redeemLoginCode']` koja se dispatchuje
sa `authCtx = null`. To je jedina tačka u kojoj se probija postojeće pravilo
"sve je autentikovano", pa je vredna posebne pažnje u pregledu koda.

---

## 7. Ekran za administraciju

Ruta `/admin/users`, u navigaciji vidljiva samo kada je `state.user.role === 'admin'`.

> Skrivanje dugmeta **nije** zaštita. Svaka `user*` akcija proverava ulogu na
> serveru, jer klijent može poslati bilo šta. Spesenov `README.md` to izričito
> navodi i to je ispravno.

### Lista korisnika

```
┌──────────────────────────────────────────────────────────────────────┐
│  Korisnici                                    [ + Dodaj korisnika ]  │
│  [ Pretraga: ime ili email          ]  [ Svi ▾ ]                     │
├──────────────────────────────────────────────────────────────────────┤
│  Marko Marković                                            ⋮         │
│  marko@firma.rs · Admin · Aktivan                                    │
│  Poslednja prijava: pre 2 sata · 2 uređaja                           │
├──────────────────────────────────────────────────────────────────────┤
│  Ana Anić                                                  ⋮         │
│  ana@firma.rs · Inspektor · Aktivna · još se nije prijavila          │
│  1 uređaj                                                            │
├──────────────────────────────────────────────────────────────────────┤
│  Petar Petrović                                            ⋮         │
│  petar@firma.rs · Inspektor · Ugašen                                 │
│  Ugasio: Marko Marković, 12.03.2026.                                 │
└──────────────────────────────────────────────────────────────────────┘
```

Filteri: *Svi · Aktivni · Ugašeni · Administratori · Još se nisu prijavili*.

### Akcije po korisniku (meni `⋮`)

| Akcija | Ponašanje |
|---|---|
| **Ugasi pristup** | Modal sa potvrdom. Postavlja `status: disabled` i **odmah opoziva sve uređaje** te osobe. |
| **Vrati pristup** | `status: active`. Uređaji se ne vraćaju — osoba se prijavljuje ponovo. |
| **Daj admin prava** | Modal sa potvrdom i jasnim tekstom šta admin može. |
| **Oduzmi admin prava** | Isto, uz upozorenje ako je to poslednji admin. |
| **Uređaji** | Panel: naziv, poslednji put korišćen, datum isteka. Po redu *Odjavi*, i *Odjavi sve*. |
| **Istorija** | Zapisi iz `AuditLog` za tog korisnika — ko ga je otvorio, kada je gašen i vraćan, prijave. |

### Dodavanje korisnika

Ime, email, uloga. Kreira red sa `status: active`, šalje mejl dobrodošlice sa
linkom na aplikaciju i objašnjenjem da se prijavljuje mejlom i kodom. Badge
*još se nije prijavio* stoji dok `lastLoginAt` ne dobije vrednost.

---

## 8. Zaštitne ograde

Bez ovih pravila jedan pogrešan klik ostavlja firmu bez pristupa sopstvenom sistemu.

1. **Korisnik ne može da ugasi sam sebe.**
2. **Korisnik ne može sebi da oduzme admin prava.**
3. **Poslednji aktivan admin ne može biti ugašen ni demovan.** Pravila 1 i 2 to
   uglavnom već sprečavaju, ali provera se piše eksplicitno — kao odbrana od
   budućih akcija (na primer brisanja korisnika) koje bi zaobišle tu logiku.
4. **Break-glass ostaje.** Funkcija `bootstrapFirstAdmin(email, name)` ostaje u
   editoru zauvek, ne samo za prvo postavljanje. Ako poslednjem adminu prestane
   da radi mejl ili izgubi sve uređaje, to je jedini put nazad. Ovo je stvarna
   rupa u modelu "sve iz UI" i treba je pokriti svesno, a ne slučajno.
5. **Email je jedinstven**, poređenje bez razlike u veličini slova. Duplikat se
   odbija sa jasnom porukom.
6. **Svaka mutacija piše u `AuditLog`** sa punim identitetom onoga ko ju je izvršio.

---

## 9. Ograničenja učestalosti

Apps Script ne daje pouzdanu IP adresu pozivaoca, pa je jedini realan ključ mejl.

| Akcija | Ograničenje |
|---|---|
| `requestLoginCode` | 1 zahtev na 60 sekundi po mejlu (da se ne zatrpava inbox) |
| `requestLoginCode` | najviše 5 na sat po mejlu |
| `redeemLoginCode` | 5 pogrešnih pokušaja → kod se poništava |
| `redeemLoginCode` | 10 neuspelih na sat po mejlu → pauza 15 minuta |

Brojači u `CacheService`. Poslednje pravilo je ekvivalent Spesenovih kolona
`Fehler` i `GesperrtBis`, samo bez pisanja u tabelu.

**Napomena o kvotama:** `MailApp` ima dnevni limit — 100 primalaca za obične
Gmail naloge, 1500 za Workspace. Za očekivan broj prijava to je daleko iznad
potrebe, ali vredi znati da limit postoji. Mejlovi stižu sa adrese vlasnika
skripte, pa prvi test treba da obuhvati i proveru da ne završavaju u spamu.

---

## 10. Nove API akcije

Dodaju se u `Router.gs`. Sve osim prve dve zahtevaju `requireAdmin`.

```
requestLoginCode(email)                              javno
redeemLoginCode(email, code, deviceLabel, remember)  javno
refreshSession()                                     token uređaja
me()                                                 bilo koja sesija

listUsers(filter)                                    admin
createUser(name, email, role)                        admin
setUserStatus(userId, status)                        admin
setUserRole(userId, role)                            admin
listUserDevices(userId)                              admin
revokeDevice(deviceId)                               admin
getAuthLog(userId?)                                  admin
```

---

## 11. Migracija — četiri faze, svaka isporučiva zasebno

**Faza 0 — odmah, nezavisno od svega ostalog**
Opozvati kompromitovani admin token iz `gas/BootstrapService.gs:202`
(`revokeAdminTokenByNonce('6ff63234c6e4727b')`) i izbaciti ga iz izvornog koda.
Ovo ne čeka ostatak posla.

**Faza 1 — temelji, bez vidljive promene**
Listovi `Users` i `Devices`, `UserService.gs`, `DeviceService.gs`, novi tipovi
tokena. `resolveAuth` prihvata **i** stari admin token **i** novu sesiju.
Ništa se ne kvari, niko ništa ne primećuje.

**Faza 2 — ekran i prelazak ljudi**
`/admin/users`, novi ekran za prijavu, upisati prave korisnike. Svi prelaze na
novu prijavu. Stari token i dalje radi kao mreža za pad.

**Faza 3 — čišćenje**
Izbaciti granu sa `ADMIN_NONCES` iz `resolveAuth`, obrisati
`generateAdminTokenForMe()` i `listAdminTokens()`, obrisati Script Property
`ADMIN_NONCES`. Ažurirati `docs/api-contract.md`, koji još opisuje Google
prijavu koje odavno nema u kodu.

---

## 12. Procena obima

| Deo | Fajl | Približno linija |
|---|---|---|
| Korisnici | `gas/UserService.gs` (novo) | 230 |
| Uređaji | `gas/DeviceService.gs` (novo) | 120 |
| Mejlovi | `gas/MailService.gs` (novo) | 80 |
| Izmene autentikacije | `gas/Authservice.gs` | 130 |
| Javne akcije | `gas/Code.gs` | 15 |
| Rute | `gas/Router.gs` | 10 |
| Listovi i CRUD | `gas/SheetService.gs` | 150 |
| Ekran za administraciju | `js/pages.js` | 320 |
| Novi ekran za prijavu | `js/pages.js` | 150 |
| Klijentska logika | `js/auth.js`, `api.js`, `state.js` | 120 |
| **Ukupno** | | **~1330** |

Realna procena: **3–4 dana** fokusiranog rada za implementaciju, plus **1 dan**
za prolazak kroz test scenarije iz tačke 13.

---

## 13. Test scenariji pre puštanja u rad

Preuzet obrazac iz Spesenovog `README.md` — tamo se pokazao kao koristan.

| # | Scenario | Očekivano |
|---|---|---|
| 1 | Prijava mejlom koji ne postoji | Ista poruka kao za postojeći; nijedan mejl ne stiže |
| 2 | Pogrešan kod pet puta | Šesti pokušaj odbijen i sa ispravnim kodom |
| 3 | Kod posle 10 minuta | Odbijen |
| 4 | Isti kod dva puta | Drugi put odbijen |
| 5 | Prijava bez "Zapamti uređaj" | Posle 12 sati traži novi kod |
| 6 | Prijava sa "Zapamti uređaj" | Posle 12 sati se obnavlja tiho, bez mejla |
| 7 | Admin ugasi prijavljenog korisnika | Njegov sledeći zahtev odbijen u roku od minuta |
| 8 | Admin oduzme admin prava prijavljenom adminu | Ekran `/admin/users` mu nestaje, akcije odbijene |
| 9 | Običan korisnik ručno pošalje `listUsers` | `FORBIDDEN` |
| 10 | Admin pokuša da ugasi sebe | Odbijeno |
| 11 | Admin pokuša da sebi oduzme prava | Odbijeno |
| 12 | Pokušaj da se ugasi poslednji admin | Odbijeno sa jasnim objašnjenjem |
| 13 | Dodavanje korisnika sa postojećim mejlom | Odbijeno |
| 14 | Odjava jednog uređaja | Taj uređaj traži prijavu, drugi nastavlja da radi |
| 15 | Link stanara `?t=` | Radi nepromenjeno kroz sve faze |
| 16 | Zapis u `AuditLog` posle izmene inspekcije | `actor` je mejl osobe, ne oznaka uređaja |

Scenario 2 zaključava nalog na 15 minuta — raditi ga sa testnim nalogom.

---

## 14. Sporedna korist

Uz ovaj posao rešavaju se i tri nalaza iz ranije analize prijave, bez dodatnog truda:

- `Utils.randomHex` koristi `Math.random()`, koji nije kriptografski generator, a
  proizvodi sve nonce-ove. Novi kod za generisanje kodova i nonce-ova uvodi
  izvor zasnovan na `Utilities.getUuid()`, koji zamenjuje i postojeću upotrebu.
- Token uređaja od 60 dana zamenjuje admin token od 365 dana.
- `actor` u celom `AuditLog`-u postaje ime osobe umesto slobodnog teksta iz tokena.

---

## 15. Pitanja na koja treba tvoj odgovor pre početka

1. **Uloge** — da li su dovoljne `admin` i `inspector`, ili treba i `viewer`
   (samo čitanje, bez izmene inspekcija)?
2. **Kredencijal** — potvrđuješ opciju B (kod na mejl), ili preferiraš A zbog
   doslednosti sa Spesenom, odnosno C ako su svi na Google Workspace-u?
3. **Trajanje uređaja** — 30, 60 ili 90 dana?
4. **Vidljivost inspekcija** — sada svaki admin vidi sve. Treba li inspektor da
   vidi samo svoje inspekcije, ili i dalje sve? Ovo utiče na `listInspections` i
   nije obuhvaćeno gornjom procenom obima.
