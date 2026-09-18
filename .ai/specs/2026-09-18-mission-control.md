# Mission Control — wizualny widok roju agentów

Data: 2026-09-18
Autor: Wiktor Idzikowski (brainstorming z Claude)
Status: draft — do przekazania do writing-plans

## Cel

Obecny widok Tasks (`/`) to tabela — dobra do pracy, słaba na scenie/demie. Mission
Control to nowy, czysto frontendowy widok dla dziesiątek/kilkunastu równoległych
agentów, z dwoma trybami:

1. **Grid/Radar** — siatka kafelków, jeden kafelek = jeden agent, animowany status,
   live tokeny/koszt, miniaturka ostatniego tool-calla.
2. **Swarm Graph** — animowany graf drzewa: węzeł-matka (root run) → gałęzie do
   podtasków (dispatch), kolor/animacja wg statusu.

Cel biznesowy: efekt "dziesiątki agentów ujarzmione w jednym miejscu" — czytelny na
pierwszy rzut oka, dobry na hackathonowe demo.

## Ograniczenia i założenia

- **Zero zmian w rdzeniu/backendzie.** Cały moduł to nakładka na już istniejące
  źródła danych: workspace SSE (`run`, `usage` eventy) i per-run SSE (`run-events`,
  transkrypt tool-calli). Żadnych nowych endpointów, żadnych zmian w kontrakcie
  (`packages/contract`).
- Skala docelowa: ~10-20 równoległych agentów widocznych naraz. Powyżej tego widok
  ma się nadal renderować (pan/zoom w grafie, scroll w gridzie), ale wydajność dla
  setek agentów jest jawnie poza zakresem.
- Reużywamy istniejący model hierarchii task→podtaski (`dispatch.parentRunId` /
  `dispatch.rootRunId` w `packages/contract/src/dispatch.ts`) i istniejącą czystą
  logikę budowania drzewa z `packages/web/src/lib/task-tree.ts` (`buildTaskTree`) —
  nic nowego nie jest wymyślane po stronie modelu danych.

## Architektura i routing

- Nowa trasa `/mission-control`, osobna pozycja w nawigacji obok "Tasks". Nie
  dotyka istniejącego route'a `tasks-overview.tsx` ani jego tabeli.
- Wewnątrz widoku: toggle **Grid ⇄ Swarm Graph**, stan persystowany per-workspace
  (analogicznie do dziś persystowanych kolumn tabeli — ten sam mechanizm
  storage'u).
- Nowy katalog: `packages/web/src/routes/mission-control/` zawierający:
  - `mission-control-route.tsx` — routing/wiring (query, SSE hooks)
  - `mission-control-grid.tsx` — widok Grid
  - `mission-control-graph.tsx` — widok Swarm Graph
  - `agent-tile.tsx` — współdzielony komponent kafelka (używany też jako treść
    custom node'a w grafie)
  - `task-tree-to-flow.ts` — czysta funkcja transformująca wynik `buildTaskTree`
    na `nodes[]`/`edges[]` dla react-flow
  - `use-visible-run-events.ts` — hook do warunkowej subskrypcji per-run SSE dla
    widocznych elementów

## Grid / Radar view

- Responsywna siatka CSS (`grid-template-columns: repeat(auto-fill, minmax(...))`).
  Aktywne runy (`queued`/`running`/`waiting`/`review`) na górze; zakończone
  (`done`/`failed`/`cancelled`) zwinięte w osobną, domyślnie schowaną sekcję
  "ostatnio zakończone".
- `AgentTile` renderuje:
  - tytuł taska, workflow/model
  - status jako kolor + animacja: pulsujące obramowanie dla `running`,
    przerywana/wolniejsza pulsacja dla `queued`, bursztynowy akcent dla
    `waiting`/`review`, statyczny dla stanów końcowych
  - `tokensUsed` i `costUsd` aktualizowane live z workspace `usage` SSE
  - badge z liczbą podtasków (na podstawie `task-tree.ts`)
  - miniaturkę ostatniego tool-calla (patrz niżej), tylko gdy dostępna
- Klik na kafelek nawiguje do istniejącego widoku szczegółów runa — nic nowego do
  zbudowania po stronie drill-down.

### Live tool-call — zasada widoczności

Pole "ostatni tool-call" nie istnieje w `RunRecord` — pojawia się wyłącznie jako
zdarzenie w per-run transkrypcie (`run-events`, `useRunEvents`). Otwieranie
per-run SSE dla każdego runa naraz przy 10-20 agentach byłoby zbędnym obciążeniem
i częściowo zaprzecza założeniu "lekka nakładka".

Rozwiązanie: `useVisibleRunEvents(runId)` — hook oparty o `IntersectionObserver`,
który:
- subskrybuje `run-events` (przez istniejący `useRunEvents`) tylko dla kafelków
  aktualnie w viewport ORAZ w statusie `running`
- wyciąga ostatni event reprezentujący tool-call i renderuje jednolinijkową
  miniaturkę (np. `🔧 Read src/foo.ts`)
- zamyka subskrypcję, gdy kafelek wypada z viewportu lub zmienia status na
  nie-`running`

## Swarm Graph view

- Biblioteka: `@xyflow/react` (react-flow) — nowa zależność, nic podobnego nie ma
  dziś w `packages/web/package.json`. Bez `MiniMap` (niepotrzebny przy tej skali).
- Layout drzewa: `dagre` (lub równoważny prosty layout per-poziom) do policzenia
  pozycji węzłów na podstawie `dispatch.parentRunId` — react-flow sam nie
  layoutuje grafów.
- Custom node type = uproszczona wersja `AgentTile`: tytuł, kolor/animacja statusu,
  mini tokeny/koszt.
- Krawędzie: `animated: true` (react-flow) dla gałęzi, których dziecko jest wciąż
  `running`/`queued`; statyczne dla zakończonych.
- Runy bez rodzica i bez dzieci (pojedyncze, niezdispatchowane) renderowane jako
  osobne izolowane węzły/wyspy na tym samym canvasie — graf nie gubi "zwykłych"
  tasków spoza drzew dispatch.
- Klik na węzeł → ten sam drill-down co w Grid.
- Transformacja danych: `taskTreeToFlow(buildTaskTree(runs))` — czysta, testowalna
  funkcja w `task-tree-to-flow.ts`. `task-tree.ts` pozostaje niezmieniony.

## Error handling i edge case'y

- Rozłączenie per-run SSE dla tool-calla: kafelek/węzeł przestaje się aktualizować,
  pokazuje ostatnią znaną wartość z subtelnym oznaczeniem "stale" — bez błędu
  blokującego cały widok. Istniejący `useRunEvents` ma już reconnect/watchdog.
- Pusty stan (brak aktywnych runów): placeholder z komunikatem "brak agentów w
  akcji".
- Głęboko zagnieżdżone lub bardzo liczne drzewa (poza zakładanym 10-20): widok się
  nie wywala, po prostu skaluje przez pan/zoom react-flow — jawnie udokumentowane
  jako znane ograniczenie MVP, nie coś do rozwiązania teraz.

## Testowanie

- Unit testy dla `taskTreeToFlow()` — deterministyczna, czysta transformacja,
  łatwa do pokrycia bez renderowania UI.
- Manualna weryfikacja w przeglądarce (moduł czysto wizualny) — brak nowych API do
  testowania kontraktowego, bo backend się nie zmienia.
- Sprawdzenie, że toggle Grid/Graph nie gubi stanu (np. który run jest
  podświetlony) przy przełączaniu widoków.

## Poza zakresem MVP

- Filtrowanie/wyszukiwanie w gridzie
- Zapisywanie/pamiętanie layoutu grafu między sesjami
- Eksport/screenshot widoku
- Wirtualizacja/canvas dla setek agentów naraz
- Akcje/edycja z poziomu kafelka lub węzła (poza nawigacją do szczegółów runa)

## Powiązane specyfikacje

- `.ai/specs/2026-09-10-dispatch.md` — model dispatch/subagent tree, źródło
  hierarchii wykorzystywanej w Swarm Graph
- `.ai/specs/2026-07-20-grouped-subagent-display.md`
- `.ai/specs/004-cockpit-tasklist.md`
- `.ai/specs/2026-07-30-foldable-task-table-columns.md`
- `.ai/specs/2026-07-30-session-usage-metrics.md`
