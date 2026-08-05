# Predlog: administracija naloga u handoverApp

Status: predlog za sprovođenje
Autor: pripremljeno za vlasnika sistema
Verzija: 2.0 — ugrađene donete odluke

---

## 1. Cilj

Uvesti pojam **korisnika** u handoverApp i ekran na kome ovlašćena osoba:

- dodaje nove korisnike i daje im pristup,
- gasi pristup postojećim,
- dodeljuje i oduzima admin prava,
- vidi ko se i kada prijavljivao i sa kog uređaja, i može taj uređaj da odjavi.

**Šta ovaj predlog namerno ne dira:** tok za stanare. Link sa `?t=` tokenom,
`requireMatchingInspection` i `requireMatchingRole` ostaju netaknuti. Stanari
nemaju naloge i ne treba da ih imaju.

---

## 2. Zašto je ovo potrebno

Trenutno stanje (`gas/Authservice.gs`) nema pojam osobe. Postoji samo uloga
`admin` i lista nonce-ova u Script Properties.

| Pitanje | Trenutni odgovor |
|---|---|
| Ko je izmenio ovu inspekciju? | `admin:Dušan main device` — slobodan tekst iz tokena, ne zapis o osobi |
| Kako da damo pristup novom kolegi? | Otvoriti Apps Script editor, izmeniti konstantu `LABEL`, pokrenuti funkciju, prekopirati token iz loga |
| Kako da oduzmemo pristup? | Otvoriti editor, pokrenuti `listAdminTokens()`, naći nonce, pokrenuti `revokeAdminTokenByNonce()` |
| Ko ima pristup upravo sada? | Samo iz editora |

Pristup sistemu, dakle, može da menja samo osoba koja ume da uđe u Apps Script
editor — a to je isti nivo pristupa kao i mogućnost da promeni ceo backend.
Nema srednjeg nivoa.

---

## 3. Donete odluke

| Pitanje | Odluka |
|---|---|
| Kredencijal | **Email + lozinka**, isti model kao Spesen |
| Uloge | **`admin` + `inspector`** |
| Vidljivost inspekcija | **Inspektor vidi samo svoje**, admin vidi sve |

Ostatak dokumenta pisan je za ove tri odluke. Dve od njih povlače posledice koje
treba pročitati pažljivo: lozinka zahteva sekciju 5 (čuvanje lozinke u okruženju
koje za to nema alat), a "samo svoje" zahteva sekciju 9 (jer `createdBy` nije
isto što i "čija je inspekcija").

---

## 4. Model podataka

Dva nova lista u postojećoj radnoj svesci, uklopljena u `SheetService.COLUMNS`,
i jedna nova kolona na postojećem listu.

### List `Users`

| Kolona | Opis |
|---|---|
| `userId` | `USR-YYYY-NNNNNN`, isti obrazac kao `generateInspectionId()` |
| `email` | mala slova, **jedinstven** — prirodni ključ |
| `name` | ime i prezime; ide u audit i u PDF |
| `role` | `admin` \| `inspector` |
| `status` | `active` \| `disabled` |
| `passHash` | vidi sekciju 5 — jedna samoopisna vrednost, ne hash + salt zasebno |
| `passSetAt` | kada je lozinka poslednji put postavljena |
| `failedCount` | brojač uzastopnih promašaja |
| `lockedUntil` | ISO vreme do kada je nalog zaključan; prazno kad nije |
| `createdAt` / `createdBy` | ko je i kada otvorio nalog |
| `disabledAt` / `disabledBy` | ko je i kada ugasio |
| `lastLoginAt` | poslednja uspešna prijava |
| `notes` | slobodan tekst za admina |

Namerno **samo dva statusa**. Spesenovo treće stanje (`PwGeaendert = false`,
"noch nicht angemeldet") ovde ne postoji kao kolona — izvodi se iz praznog
`passHash` i prikazuje kao badge *još nije postavio lozinku*. Jedno stanje manje
je jedan prelaz manje koji može da se pokvari.

### List `Devices`

| Kolona | Opis |
|---|---|
| `deviceId` | `DEV-YYYY-NNNNNN` |
| `userId` | vlasnik |
| `label` | "iPhone Safari", predlaže se iz User-Agenta, korisnik može da promeni |
| `nonce` | vrednost za opoziv |
| `createdAt` / `lastSeenAt` | za prikaz "poslednji put korišćen pre 3 dana" |
| `expiresAt` | 60 dana od kreiranja |
| `revokedAt` / `revokedBy` | ko je i kada odjavio uređaj |
| `userAgent` | pun string, za prepoznavanje sumnjivog uređaja |

Ovaj list **zamenjuje** `ADMIN_NONCES` iz Script Properties, i ujedno igra ulogu
Spesenovog lista `Sessions` — ali sa imenom uređaja, istorijom i dugmetom za
odjavu, umesto reda koji se briše ručno.

### Izmena postojećeg lista `Inspections`

Dodaje se kolona **`assignedTo`** (email inspektora). Razlog je objašnjen u
sekciji 9 — bez nje odluka "inspektor vidi samo svoje" ne funkcioniše u praksi.

### Privremene vrednosti — **ne u tabelu**

Tokeni za postavljanje lozinke i brojači učestalosti čuvaju se u
`CacheService.getScriptCache()`. Sami se brišu, ne ostavljaju trag u trajnom
skladištu i ne mogu se pročitati iz tabele.

### Audit — postojeći list `AuditLog`

Nema novog lista. Za događaje vezane za naloge `inspectionId` ostaje prazan, a
dodaju se tipovi:

```
login_succeeded        login_failed          account_locked
password_set           password_changed      password_reset_sent
user_created           user_disabled         user_enabled
role_granted           role_revoked
device_registered      device_revoked
inspection_assigned
```

`actor` postaje `user:ime.prezime@firma.rs` umesto `admin:<8 znakova tokena>`.
Time i svaki postojeći zapis u inspekcijama dobija pravo ime osobe.

---

## 5. Čuvanje lozinke — najosetljiviji deo posla

Ovo je jedina tačka u kojoj izbor lozinke traži pažnju kakvu ostatak posla ne
traži, pa je treba pročitati u celini pre nego što se krene.

### Problem

Apps Script nema ni bcrypt, ni scrypt, ni Argon2, ni ugrađen PBKDF2. Jedino što
postoji je `Utilities.computeDigest` (jedan prolaz SHA-256) i
`Utilities.computeHmacSha256Signature`. Naivno rešenje — `sha256(salt + lozinka)`,
što je ono što Spesenov model kolona `PassHash` + `Salt` sugeriše — daje hash
koji se na običnom GPU proverava milijardama pokušaja u sekundi. Ako bilo ko
ikada dobije pristup radnoj svesci, sve lozinke koje nisu duge padaju za nekoliko
minuta.

### Rešenje

PBKDF2-HMAC-SHA256 napisan ručno nad postojećom primitivom:

```js
function _pbkdf2Sha256(password, saltBytes, iterations) {
  // dkLen = 32 → jedan blok, INT(1) = 0x00000001
  const block = saltBytes.concat([0, 0, 0, 1]);
  let u = Utilities.computeHmacSha256Signature(block, password);
  const out = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, password);
    for (let j = 0; j < out.length; j++) out[j] ^= u[j];
  }
  return out;
}
```

Vrednost u koloni `passHash` je samoopisna, u jednom polju:

```
pbkdf2-sha256$<brojIteracija>$<saltBase64>$<hashBase64>
```

Zašto jedno polje umesto Spesenova dva: broj iteracija se upisuje **uz svaki
hash**. To znači da za godinu dana možeš podići broj iteracija, a postojeći
korisnici nastave da rade — njihov red se preračuna pri sledećoj uspešnoj
prijavi, kada je lozinka u memoriji. Sa fiksnim brojem iteracija u kodu to nije
moguće bez resetovanja svih lozinki.

### Koliko iteracija — izmereno

Prva verzija ovog dokumenta procenjivala je 1.000–5.000 iteracija. **Ta procena
je bila pogrešna, i to na gore.** Merenje na stvarnom deploymentu
(`benchmarkPbkdf2()`):

| Iteracija | Vreme | Po iteraciji |
|---|---|---|
| 1.000 | 2.516 ms | 2,52 ms |
| 5.000 | 10.798 ms | 2,16 ms |
| 20.000 | 52.146 ms | 2,61 ms |

Dakle **oko 2,5 ms po iteraciji**, što znači svega ~400 iteracija po sekundi.
To je red veličine gore od procene.

Pošto se prijava dešava jednom u 12 sati, odnosno jednom u 60 dana na zapamćenom
uređaju, budžet od 1 sekunde je bio nepotrebno strog. Uzeto je **2,5 sekunde**,
što daje **1.000 iteracija** — vrednost koja ide u `Config` pod `pbkdf2Iterations`.

### Šta ovo jeste, a šta nije — bez ulepšavanja

Ovde je važno ne prevariti se sopstvenim brojkama. Onih 2,5 ms po iteraciji
**nije 2,5 ms posla za napadača.** Gotovo sve to je cena prelaska iz JavaScripta
u platformu — režija koju napadač sa native kodom uopšte ne plaća. On plaća samo
stvarni SHA-256, reda desetina nanosekundi. Odnos je otprilike 50.000:1 na našu
štetu.

Praktično: 1.000 iteracija znači oko 2.000 SHA-256 operacija po pokušaju. Jedna
ozbiljna grafička karta radi reda 10¹⁰ SHA-256 u sekundi, dakle **oko 5 miliona
pokušaja u sekundi** protiv ukradene tabele. Šta to znači:

| Lozinka | Vreme da padne |
|---|---|
| 12 znakova, ljudski izabrana (~35 bita) | nekoliko sati |
| 16 znakova, fraza od 4 reči (~50 bita) | nekoliko godina |

Zaključak je jednoznačan i menja jednu odluku iz prve verzije: **12 znakova nije
dovoljno.**

**Sigurnost u ovom modelu nosi dužina lozinke, ne funkcija za hešovanje.** Zato:

- **Minimum 16 znakova**, ne 12. Na 16 znakova čovek prestaje da piše reč i
  počinje da piše frazu, a to vredi više od bilo kog broja iteracija. I dalje
  bez pravila o velikim slovima i brojevima — ona proizvode `Lozinka1!`.
- Lista čestih lozinki, kakva je prvo bila predviđena, **ovde je beskorisna** —
  svaka lozinka na takvoj listi je kraća od 16 znakova, pa je pravilo o dužini
  već odbija. Ono što pravilo o dužini *ne* hvata jeste način na koji ljudi to
  zaobilaze: `password12345678`, `lozinkalozinka12`. Zato se proverava **osnova**
  posle skidanja popune i ponavljanja.
- Zaključavanje naloga iz sekcije 11 je obavezno, ne opcija — ono je jedina
  odbrana od pogađanja preko mreže, gde napadač jeste plaća naših 2,5 ms.
- **Radna sveska ne sme biti deljena šire nego što mora.** Ceo račun iznad važi
  tek ako napadač dođe do hash-eva. Dok tabela ostaje uska, ovo je teorijski
  rizik; čim se podeli, postaje praktičan.

Ako se ispostavi da je 16 znakova preveliko opterećenje za ljude, vrednost se
menja u `Config` pod `passwordMinLength` — ali uz svest o tabeli iznad.

### Prvo postavljanje lozinke — bez lozinke u mejlu

Spesen šalje početnu lozinku mejlom i kolonom `PwGeaendert` tera korisnika da je
promeni; njegov `README.md` sam navodi da lozinka time jednom prođe kroz
nešifrovanu poštu. To se izbegava bez izlaska iz modela lozinke:

Mejlom ide **jednokratni link za postavljanje lozinke** — potpisan token iz
postojeće HMAC mašinerije, `{typ:'setpw', uid, exp, nonce}`, koji važi 48 sati i
troši se pri prvoj upotrebi. Korisnik otvara link i **sam bira** lozinku. Nijedna
lozinka nikada ne putuje mejlom, i ne postoji prelazno stanje u kome nalog ima
lozinku koju zna i pošiljalac.

Isti mehanizam pokriva i reset: admin klikne *Pošalji link za novu lozinku*, ili
korisnik sam zatraži preko *Zaboravio sam lozinku*.

---

## 6. Model tokena i provera prava

Posle uspešne prijave izdaju se tokeni u postojećem formatu
`base64url(payload).hmac`:

| Tip | Payload | Trajanje |
|---|---|---|
| Sesija | `{typ:'s', uid, did, exp, nonce}` | 12 sati |
| Uređaj | `{typ:'d', uid, did, exp, nonce}` | 60 dana |
| Postavljanje lozinke | `{typ:'setpw', uid, exp, nonce}` | 48 sati, jednokratan |
| Stanar | `{iid, role:'tenant', exp, nonce}` | **nepromenjeno** |

### Najvažnije pravilo celog predloga

> **Uloga se ne nalazi u tokenu.** Token nosi identitet (`uid`), a ovlašćenje se
> čita iz reda u listu `Users` pri svakom zahtevu.

Bez ovog pravila ekran za administraciju ne radi ono što obećava. Da `role` stoji
u potpisanom tokenu, "oduzeo sam mu admin prava" značilo bi "prestaće da bude
admin za 12 sati" — a to nije ono što administrator misli da je uradio kada
klikne dugme. Isto važi za gašenje naloga.

### Provera na svaki zahtev

Nadogradnja `AuthService.verifyToken()`:

1. HMAC potpis i `exp` — postojeći kod, nepromenjen
2. `did` → red u `Devices`: postoji, `revokedAt` prazan, `nonce` se poklapa, nije istekao
3. `uid` → red u `Users`: `status === 'active'`
4. `authCtx` dobija `role`, `email`, `name` iz tog reda, i `actorString = 'user:' + email`

Koraci 2 i 3 su dva dodatna čitanja iz Sheetsa po API pozivu. Rešava se
`CacheService` keširanjem po ključevima `u:<uid>` i `d:<did>` sa TTL 60 sekundi,
koje se **briše pri svakoj izmeni** korisnika ili uređaja. Isti obrazac već
postoji u `Config.gs` (keš od 30 sekundi), pa je dosledno.

**Kompromis koji treba prihvatiti:** promena uloge ili gašenje naloga stupaju na
snagu u roku od 60 sekundi, ne trenutno. Uz to gašenje naloga **odmah** opoziva
sve uređaje te osobe — pa ugašeni korisnik u najgorem slučaju ima još jedan minut
pristupa sa uređaja koji je već bio prijavljen, i nijednu mogućnost nove prijave.

### Promena lozinke poništava sve sesije

Kao u Spesenu, i s pravom. Izvodi se opozivom svih redova u `Devices` za tog
korisnika — bez nove kolone i bez nove logike. Izgubljen ili tuđ uređaj se time
odjavljuje sam.

---

## 7. Tokovi

```
PRVI PRISTUP
  Admin doda korisnika (ime, email, uloga)
    → red u Users, passHash prazan, status active
    → mejl sa jednokratnim linkom, važi 48h
  Korisnik otvara link → bira lozinku (min 12 znakova) → prijavljen
    → token se troši, passSetAt upisan

PRIJAVA
  /login  →  email + lozinka  +  [x] Zapamti ovaj uređaj
    ├─ nalog ne postoji ILI status != active
    │    → ista poruka kao za pogrešnu lozinku, isto trajanje odgovora
    ├─ lockedUntil u budućnosti
    │    → "Previše pokušaja. Pokušajte ponovo za N minuta."
    ├─ lozinka pogrešna
    │    → failedCount++, na 5 → lockedUntil = sada + 15 min
    │    → zapis login_failed
    └─ lozinka ispravna
         → failedCount = 0, lockedUntil = prazno
         → red u Devices, lastLoginAt upisan
         → { sessionToken, deviceToken?, user:{name,email,role} }
         → ako je broj iteracija u bazi manji od tekućeg, preračunaj hash

ISTEK SESIJE
  ima deviceToken → refreshSession() tiho
  nema           → nazad na /login

PROMENA LOZINKE  (sam korisnik, ekran /profil)
  stara + nova + potvrda → svi uređaji opozvani → ponovna prijava

ZABORAVLJENA LOZINKA
  email → uvek ista poruka bez obzira na postojanje naloga
        → ako nalog postoji i aktivan je, mejl sa linkom (48h)

RESET OD STRANE ADMINA
  Dugme "Pošalji link za novu lozinku" → isti mejl
  Stara lozinka prestaje da važi tek kada korisnik postavi novu
```

---

## 8. Ekran za administraciju

Ruta `/admin/users`, u navigaciji vidljiva samo kada je `state.user.role === 'admin'`.

> Skrivanje dugmeta **nije** zaštita. Svaka `user*` akcija proverava ulogu na
> serveru, jer klijent može poslati bilo šta. Spesenov `README.md` to izričito
> navodi i to je ispravno.

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
│  ana@firma.rs · Inspektor · Aktivna · još nije postavila lozinku     │
│  Link poslat 12.03.2026.                                             │
├──────────────────────────────────────────────────────────────────────┤
│  Petar Petrović                                            ⋮         │
│  petar@firma.rs · Inspektor · Zaključan do 14:32                     │
│  5 neuspelih pokušaja                                                │
├──────────────────────────────────────────────────────────────────────┤
│  Jovana Jovanović                                          ⋮         │
│  jovana@firma.rs · Inspektor · Ugašen                                │
│  Ugasio: Marko Marković, 12.03.2026.                                 │
└──────────────────────────────────────────────────────────────────────┘
```

Filteri: *Svi · Aktivni · Ugašeni · Administratori · Bez lozinke · Zaključani*.

### Akcije po korisniku (meni `⋮`)

| Akcija | Ponašanje |
|---|---|
| **Ugasi pristup** | Modal sa potvrdom. `status: disabled` i **odmah opoziva sve uređaje**. |
| **Vrati pristup** | `status: active`. Uređaji se ne vraćaju — osoba se prijavljuje ponovo. |
| **Daj admin prava** | Modal sa potvrdom i jasnim tekstom šta admin može. |
| **Oduzmi admin prava** | Isto, uz upozorenje ako je to poslednji admin. |
| **Pošalji link za novu lozinku** | Jednokratan link, 48 sati. |
| **Otključaj nalog** | Vidljivo samo kad je nalog zaključan; briše `lockedUntil` i `failedCount`. |
| **Uređaji** | Panel: naziv, poslednji put korišćen, datum isteka. Po redu *Odjavi*, i *Odjavi sve*. |
| **Istorija** | Zapisi iz `AuditLog` za tog korisnika. |

---

## 9. Vidljivost inspekcija — "inspektor vidi samo svoje"

Ova odluka ima jednu posledicu koju treba rešiti u dizajnu, jer bi se inače
pojavila tek u upotrebi.

### Problem: `createdBy` nije isto što i "čija je inspekcija"

Danas `createInspection` upisuje `createdBy` (`InspectionService.gs:61`). Ako se
vidljivost veže samo za to polje, nastaje situacija u kojoj **admin otvori
inspekciju i time je učini nevidljivom za inspektora koji treba da je odradi**.
A upravo je to najverovatniji način rada: kancelarija zavodi posao, inspektor
izlazi na teren.

### Rešenje

Nova kolona `assignedTo` na listu `Inspections`, i pravilo:

```
inspektor vidi inspekciju  ⇔  assignedTo == ja  ILI  createdBy == ja
admin vidi sve
```

- `createInspection` postavlja `assignedTo` iz forme; ako polje nije popunjeno,
  podrazumeva se onaj ko kreira.
- U ekranu za kreiranje: padajuća lista aktivnih korisnika.
- U detaljima inspekcije: akcija **Dodeli** (samo admin), sa zapisom
  `inspection_assigned` u audit.

### Tačke u kodu koje se menjaju

Postojeći `requireMatchingInspection` ograničava **samo** stanare
(`Authservice.gs:195` — uslov je `authCtx.role === 'tenant'`). Uvodi se
`requireInspectionAccess(authCtx, inspectionId)` koji pokriva sve tri uloge, i
zamenjuje postojeći poziv na ovim mestima:

| Fajl | Funkcija |
|---|---|
| `InspectionService.gs` | `getInspection`, `saveSection` |
| `AttachmentService.gs` | `uploadAttachment` |
| `SignatureService.gs` | `saveSignature` |
| `InspectionService.gs` | `listInspections` — filtriranje liste, ne odbijanje |

Ovo je najlakše mesto da se propusti jedan poziv i ostavi rupa, pa je i
najvažnije mesto za test scenarije 12–15 iz sekcije 15.

### Podrazumevano ponašanje za postojeće redove

Pri migraciji `assignedTo` se popunjava vrednošću iz `createdBy`. Redovi kod
kojih je `createdBy` stara oznaka tokena (`admin:...`) ostaju vidljivi samo
adminima — što je i ispravno, jer se za njih ne zna ko ih je stvarno radio.

---

## 10. Zaštitne ograde

Bez ovih pravila jedan pogrešan klik ostavlja firmu bez pristupa sopstvenom sistemu.

1. **Korisnik ne može da ugasi sam sebe.**
2. **Korisnik ne može sebi da oduzme admin prava.**
3. **Poslednji aktivan admin ne može biti ugašen ni demovan.** Pravila 1 i 2 to
   uglavnom već sprečavaju, ali provera se piše eksplicitno — kao odbrana od
   budućih akcija (na primer brisanja korisnika) koje bi tu logiku zaobišle.
4. **Break-glass ostaje.** Funkcija `bootstrapFirstAdmin(email, name)` ostaje u
   editoru zauvek, ne samo za prvo postavljanje. Ako poslednji admin izgubi
   lozinku i pristup mejlu, to je jedini put nazad. Ovo je stvarna rupa u modelu
   "sve iz UI" i treba je pokriti svesno, a ne slučajno.
5. **Email je jedinstven**, poređenje bez razlike u veličini slova.
6. **Svaka mutacija piše u `AuditLog`** sa punim identitetom onoga ko ju je izvršio.
7. **Poruka o neuspeloj prijavi je uvek ista** — nepostojeći nalog, pogrešna
   lozinka i ugašen nalog daju identičan odgovor. Inače se lista zaposlenih
   otkriva probanjem mejlova.

---

## 11. Ograničenja učestalosti i zaključavanje

Apps Script ne daje pouzdanu IP adresu pozivaoca, pa je jedini realan ključ mejl.

| Akcija | Ograničenje |
|---|---|
| `login` | 5 uzastopnih promašaja → `lockedUntil` = sada + 15 minuta |
| `login` | brojač se nuluje pri uspešnoj prijavi |
| `requestPasswordReset` | 1 na 60 sekundi i najviše 5 na sat po mejlu |
| `setPassword` | token jednokratan, važi 48 sati |

`failedCount` i `lockedUntil` idu u list `Users` (kao Spesenove `Fehler` i
`GesperrtBis`) jer moraju preživeti restart i biti vidljivi adminu u UI.
Brojači za reset lozinke idu u `CacheService`.

Zaključavanje je u ovom modelu **obavezno**, ne opciono — vidi sekciju 5.

**Napomena o kvotama:** `MailApp` ima dnevni limit — 100 primalaca za obične
Gmail naloge, 1500 za Workspace. Za očekivan broj mejlova to je daleko iznad
potrebe. Mejlovi stižu sa adrese vlasnika skripte, pa prvi test treba da obuhvati
i proveru da ne završavaju u spamu.

---

## 12. Nove API akcije

Dodaju se u `Router.gs`.

```
login(email, password, deviceLabel, remember)     javno
requestPasswordReset(email)                       javno
setPassword(setpwToken, newPassword)              javno
refreshSession()                                  token uređaja
me()                                              bilo koja sesija
changePassword(oldPassword, newPassword)          bilo koja sesija

listUsers(filter)                                 admin
createUser(name, email, role)                     admin
setUserStatus(userId, status)                     admin
setUserRole(userId, role)                         admin
unlockUser(userId)                                admin
sendPasswordLink(userId)                          admin
listUserDevices(userId)                           admin
revokeDevice(deviceId)                            admin
assignInspection(inspectionId, userEmail)         admin
getAuthLog(userId?)                               admin
```

Prve tri su javne, a `Code.gs` trenutno poziva `resolveAuth` pre svakog
dispatch-a (linija 30). Uvodi se lista
`PUBLIC_ACTIONS = ['login', 'requestPasswordReset', 'setPassword']` koja se
dispatchuje sa `authCtx = null`. To je jedina tačka u kojoj se probija postojeće
pravilo "sve je autentikovano", pa zaslužuje posebnu pažnju u pregledu koda.

---

## 13. Migracija — četiri faze, svaka isporučiva zasebno

**Faza 0 — odmah, nezavisno od svega ostalog**
Opozvati kompromitovani admin token iz `gas/BootstrapService.gs:202`
(`revokeAdminTokenByNonce('6ff63234c6e4727b')`) i izbaciti ga iz izvornog koda.
Ovo ne čeka ostatak posla.

**Faza 1 — temelji, bez vidljive promene** ✅ *urađeno*
Listovi `Users` i `Devices`, kolona `assignedTo`, `UserService.gs`,
`PasswordService.gs`, `DeviceService.gs`, `MailService.gs`, `AccountService.gs`,
novi tipovi tokena. `resolveAuth` prihvata **i** stari admin token **i** novu
sesiju. Ništa se ne kvari, niko ništa ne primećuje.

Uz dogovoreni obim faze uključene su i serverske akcije prijave (`login`,
`setPassword`, `requestPasswordReset`, `refreshSession`, `changePassword`, `me`,
`signOut`). Bez njih se faza ne bi mogla proveriti do kraja — ovako se ceo tok
prijave testira pre nego što se napiše i jedan ekran. Akcije za upravljanje
korisnicima (`listUsers`, `createUser`, `setUserStatus`, `setUserRole` …) ostaju
za fazu 2, zajedno sa celim frontendom.

Postupak puštanja u rad, redom:

0. **Dozvola za slanje mejla.** U editoru: ⚙ *Project Settings* → uključiti
   *Show "appsscript.json" manifest file in editor*, pa u `oauthScopes` dodati

   ```
   "https://www.googleapis.com/auth/script.send_mail"
   ```

   Ceo spisak koji ovaj backend koristi:

   | Scope | Zašto |
   |---|---|
   | `.../auth/spreadsheets` | `SpreadsheetApp` — radna sveska |
   | `.../auth/drive` | `DriveApp` — folderi, prilozi, kopija šablona |
   | `.../auth/documents` | `DocumentApp` — generisanje PDF-a |
   | `.../auth/script.send_mail` | `MailApp` — linkovi za lozinku |

   Posle izmene pokrenuti bilo koju funkciju i **prihvatiti novu autorizaciju**.
   Ako `oauthScopes` uopšte ne postoji u manifestu, Apps Script sam prepoznaje
   potrebne dozvole — ali ako spisak postoji, drži se njega i `MailApp` puca sa
   `Specified permissions are not sufficient`. Ne dirati `timeZone`.

1. `bootstrapSheet()` — pravi listove `Users` i `Devices`, dodaje kolonu
   `assignedTo` i upisuje nove ključeve u `Config`
2. `migrateAssignedTo()` — popunjava `assignedTo` na postojećim inspekcijama
3. `benchmarkPbkdf2()` — meri i predlaže `pbkdf2Iterations`; **izmerenu
   vrednost upisati u `Config` list**
4. `setupFirstAdmin()` — prvi nalog; adresa i ime se upisuju u dve označene
   linije na vrhu same funkcije, jer dugme **Run** u editoru ne može da prosledi
   argumente
5. `smokeTest()` — provera da sve stoji

Merenje iz koraka 3 nije formalnost — na ovom deploymentu je pokazalo da je
prvobitna procena bila pogrešna za red veličine, i zbog toga je minimalna dužina
lozinke podignuta sa 12 na 16 znakova. Vidi sekciju 5.

**Faza 2 — ekran i prelazak ljudi** ✅ *urađeno*
`/admin/users` sa svim akcijama i zaštitnim ogradama iz sekcije 10, novi ekran
za prijavu (`/login`), postavljanje lozinke (`/set-password`), zaboravljena
lozinka (`/forgot-password`) i sopstveni nalog (`/profile`). Stari admin token
i dalje radi kao mreža za pad.

Jedna stvar je morala da se doda van opisanog obima. Serverski su
`listInspections`, `createInspection`, `lockInspection`,
`regenerateTenantToken`, `deleteAttachment` i `finalizeInspection` tražili
`requireAdmin` — što je bilo tačno dok su postojale samo dve vrste pozivaoca,
admin i stanar. Sa ulogom `inspector` to više ne stoji: inspektor bi se
prijavio i **ne bi video nijednu inspekciju**, pa bi uloga koju admin dodeljuje
bila prazna. Uveden je `AuthService.requireStaff` — svako prijavljen ko nije
stanar. Admin ostaje potreban za nadzorne radnje: ponovno otvaranje potpisane
inspekcije, audit log i upravljanje nalozima.

To ne govori ništa o tome **koje** inspekcije inspektor vidi. To je faza 3.

Preostalo za pokretanje: dozvola `script.send_mail` (potrebna za pozivnice
novim korisnicima) i `FRONTEND_URL` sa tačnim velikim i malim slovima, jer isti
podatak gradi i linkove za stanare.

**Faza 3 — čišćenje i zatvaranje vidljivosti**
Uključiti filtriranje po `assignedTo` (do tada svi vide sve, da prelazak ne bi
sakrio nekome posao). Izbaciti granu sa `ADMIN_NONCES` iz `resolveAuth`, obrisati
`generateAdminTokenForMe()` i `listAdminTokens()`, obrisati Script Property
`ADMIN_NONCES`. Ažurirati `docs/api-contract.md`, koji još opisuje Google prijavu
koje odavno nema u kodu.

Redosled u fazi 3 je namerno takav: prvo svi imaju naloge i prijavljuju se, pa
tek onda vidljivost postaje uža. Obrnut redosled znači da nekome nestane posao sa
ekrana usred radnog dana.

---

## 14. Procena obima

| Deo | Fajl | Približno linija |
|---|---|---|
| Korisnici | `gas/UserService.gs` (novo) | 260 |
| Lozinke i PBKDF2 | `gas/PasswordService.gs` (novo) | 160 |
| Uređaji | `gas/DeviceService.gs` (novo) | 120 |
| Mejlovi | `gas/MailService.gs` (novo) | 90 |
| Izmene autentikacije | `gas/Authservice.gs` | 150 |
| Vidljivost inspekcija | `InspectionService`, `AttachmentService`, `SignatureService` | 90 |
| Javne akcije | `gas/Code.gs` | 15 |
| Rute | `gas/Router.gs` | 16 |
| Listovi i CRUD | `gas/SheetService.gs` | 170 |
| Ekran za administraciju | `js/pages.js` | 340 |
| Prijava, postavljanje i promena lozinke | `js/pages.js` | 260 |
| Klijentska logika | `js/auth.js`, `api.js`, `state.js` | 130 |
| **Ukupno** | | **~1800** |

Realna procena: **5–6 dana** fokusiranog rada, plus **1 dan** za prolazak kroz
test scenarije. Model lozinke je oko dva dana skuplji od modela sa kodom na mejl
— razlika su ekrani za postavljanje, promenu i reset, plus merenje i podešavanje
PBKDF2.

---

## 15. Test scenariji pre puštanja u rad

Obrazac preuzet iz Spesenovog `README.md`, gde se pokazao kao koristan.

| # | Scenario | Očekivano |
|---|---|---|
| 1 | Prijava mejlom koji ne postoji | Ista poruka i isto trajanje kao za pogrešnu lozinku |
| 2 | Pogrešna lozinka pet puta | Šesti pokušaj odbijen i sa ispravnom lozinkom |
| 3 | Posle 15 minuta | Prijava ponovo moguća |
| 4 | Admin klikne "Otključaj nalog" | Prijava odmah moguća |
| 5 | Link za postavljanje lozinke upotrebljen dvaput | Drugi put odbijen |
| 6 | Link stariji od 48 sati | Odbijen |
| 7 | Lozinka od 11 znakova | Odbijena, sa jasnom porukom |
| 8 | Promena lozinke | Drugi uređaj traži ponovnu prijavu |
| 9 | Prijava bez "Zapamti uređaj" | Posle 12 sati traži lozinku |
| 10 | Prijava sa "Zapamti uređaj" | Posle 12 sati se obnavlja tiho |
| 11 | Odjava jednog uređaja | Taj uređaj traži prijavu, drugi nastavlja da radi |
| 12 | Inspektor otvori tuđu inspekciju preko URL-a | `FORBIDDEN` |
| 13 | Inspektor pošalje `saveSection` za tuđu inspekciju | `FORBIDDEN` |
| 14 | Inspektor pošalje `uploadAttachment` za tuđu inspekciju | `FORBIDDEN` |
| 15 | Admin kreira inspekciju i dodeli je inspektoru | Inspektor je vidi u svojoj listi |
| 16 | Admin ugasi prijavljenog korisnika | Njegov sledeći zahtev odbijen u roku od minuta |
| 17 | Admin oduzme admin prava prijavljenom adminu | `/admin/users` mu nestaje, akcije odbijene |
| 18 | Običan korisnik ručno pošalje `listUsers` | `FORBIDDEN` |
| 19 | Admin pokuša da ugasi sebe | Odbijeno |
| 20 | Admin pokuša da sebi oduzme prava | Odbijeno |
| 21 | Pokušaj gašenja poslednjeg admina | Odbijeno sa jasnim objašnjenjem |
| 22 | Dodavanje korisnika sa postojećim mejlom | Odbijeno |
| 23 | Link stanara `?t=` | Radi nepromenjeno kroz sve faze |
| 24 | Zapis u `AuditLog` posle izmene inspekcije | `actor` je mejl osobe, ne oznaka uređaja |

Scenario 2 zaključava nalog na 15 minuta — raditi ga sa testnim nalogom.
Scenariji 12–15 pokrivaju najlakše mesto za previd iz sekcije 9.

**Scenariji 1–11 su automatizovani** u `tests/` i pokreću se sa `node tests/run.js`
— bez zavisnosti i bez test frameworka, nad stvarnim `.gs` fajlovima uz zamenjene
Apps Script primitive. Tu je i provera koje nema u gornjoj tabeli, a najviše
vredi: PBKDF2 iz sekcije 5 poredi se sa `crypto.pbkdf2Sync` iz Node-a. Funkcija
za izvođenje ključa napisana rukom može biti pogrešna a da to ništa ne otkrije —
pogrešna ali dosledna funkcija i dalje pušta sve da se prijave, dok su sačuvani
hash-evi znatno slabiji nego što se misli.

---

## 16. Sporedna korist

Uz ovaj posao rešavaju se i tri nalaza iz ranije analize prijave, bez dodatnog truda:

- `Utils.randomHex` koristi `Math.random()`, koji nije kriptografski generator, a
  proizvodi sve nonce-ove. Nova funkcija za salt i nonce-ove zasnovana na
  `Utilities.getUuid()` zamenjuje i postojeću upotrebu.
- Token uređaja od 60 dana zamenjuje admin token od 365 dana.
- `actor` u celom `AuditLog`-u postaje ime osobe umesto slobodnog teksta iz tokena.

---

## 17. Šta ostaje otvoreno

1. **Broj PBKDF2 iteracija** — određuje se merenjem u fazi 1, ne odlukom unapred.
2. **Trajanje tokena uređaja** — predlog 60 dana; menja se jednim brojem u `Config`.
3. **Da li inspektor sme sam da kreira inspekciju**, ili samo da radi dodeljene.
   Predlog je da sme, uz automatsko `assignedTo = on sam`. Ako ne sme,
   `createInspection` dobija `requireAdmin` i ekran za kreiranje se skriva.
