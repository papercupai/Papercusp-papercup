# DAO interface concepts

Open index.html in a browser. It is self-contained and needs no build or server. The top bar switches among three directions; the screen selector opens all nineteen interface areas.

- Commons: public discovery, community participation and clear onboarding.
- Assembly: governance, decisions, voting and financial accountability.
- Workbench: projects, agents, acceptance evidence and budgets.

Work item: WI-10007470. Reuses the semantics of the existing design registry's actions, controls, modal, banner and data grid. This is a design artifact; no app scaffold or new component library is created.

All organizations, people, balances and transactions are fictional. The prototype makes no network requests or real mutations. Search/filter, navigation, join, voting, proposal drafts and transaction reviews are interactive. Tabs and secondary actions show previews rather than backend implementations.

design-spec.json captures the UI structure and governance distinctions. commons.png, assembly.png and workbench.png show the initial screen of each concept. detail-board.png compares voting, treasury and ownership across all three.

Verified in headless Chrome through Playwright: all 19 screens in all three concepts at 1440×1080 and 390×844 (114 screen/viewport combinations), with no browser script errors or horizontal page overflow. Key flows exercised search, category filter, membership terms gate, joining, ballot choice/submission, proposal draft dialog, transaction review and Escape dismissal. Screenshots were visually inspected.

The design IR passes schema validation and lint with no errors. Its one intentional warning is the documented raw HTML preview container. This is prototype verification, not testing of Papercusp's production governance, payments or equity backend.
