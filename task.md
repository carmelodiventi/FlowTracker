Task: Sviluppo "Flow Tracker" - Desktop App per Automatic Time Tracking
🎯 Obiettivo del Progetto
Realizzare un'applicazione desktop "Zero-Effort" che monitori automaticamente il tempo speso su applicazioni specifiche (whitelist) per eliminare la necessità di cliccare "Start/Stop" manualmente sui timer di lavoro.

🛠 Stack Tecnologico Richiesto
Framework: Tauri (Rust backend + React/Next.js frontend) per minimizzare l'uso di RAM.

Database: SQLite (Locale-first) per la massima privacy.

OS Target: Windows e macOS (supporto per Accessibility API / WinEvents).

🏗 Requisiti Funzionali
1. Sistema di Monitoraggio (Core)
Implementare un Process Watcher in Rust che verifichi l'applicazione in "Foreground" (focus attivo).

Whitelist System: L'utente deve poter selezionare quali app monitorare (es. Code.exe, Photoshop.exe). Se un'app non è in whitelist, il tracking deve essere ignorato.

Idle Detection: Se non viene rilevato input (mouse/tastiera) per più di 5 minuti, il timer deve entrare in pausa automatica.

2. Gestione Sessioni (Logica)
Auto-Merge: Se l'utente passa da un'app in whitelist a un'altra (es. da VS Code al Terminale), la sessione deve rimanere unificata se il cambio avviene entro un timeout configurabile (es. 2 minuti).

Naming Postumo: A fine sessione (quando l'app viene chiusa o il focus perso per lungo tempo), l'utente riceve una notifica: "Hai lavorato 1h 20m su VS Code. Vuoi dare un nome a questa task?".

3. Privacy & Filtri (Cruciale)
Privacy-First: Nessun dato deve essere inviato a server esterni. Tutto risiede in SQLite locale.

Browser Filter (Opzionale): Se l'utente abilita il browser (es. Chrome), tracciare il tempo solo se il titolo della finestra contiene parole chiave specifiche (es. "Stack Overflow", "GitHub", "Jira"). Altrimenti, ignorare il traffico web.

🗄 Schema Database (Suggerito)
Applications: ID, Name, ProcessName, Icon, IsEnabled.

Sessions: ID, AppID, StartTime, EndTime, Duration, TaskName (Nullable), Status (Pending/Confirmed).

Settings: IdleTimeout, AutoMergeThreshold, Theme (Light/Dark).

🎨 Requisiti UI/UX
Tray-Only Mode: L'app deve poter vivere nella System Tray (barra di sistema) senza occupare spazio nella barra delle applicazioni.

Dashboard: Visualizzazione a timeline (stile editing video) per vedere i blocchi di tempo della giornata.

Editing Facile: Possibilità di trascinare i bordi delle sessioni per correggere manualmente l'ora di inizio/fine.

🚩 Milestone di Sviluppo
MVP 1: Script Rust che stampa in console il nome della finestra attualmente in focus ogni 5 secondi.

MVP 2: Interfaccia Tauri per aggiungere programmi alla whitelist e salvare i log su SQLite.

MVP 3: Logica di aggregazione sessioni e interfaccia di riepilogo giornaliero.

Istruzioni per l'Agente AI:

Inizia analizzando la libreria Rust più adatta per il monitoraggio delle finestre attive su Windows e macOS (es. window-titles o active-win). Proponi una struttura di cartelle per il progetto Tauri prima di procedere con il codice.

Utilizza il server MCP di sticth per la UI l'id del progetto e' questo: 4411925327516504704