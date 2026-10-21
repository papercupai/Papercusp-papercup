/** Versioned account orientation content. Cloud domain receipts retain their own lesson/version. */
export const PRODUCT_TUTORIAL_VERSION = 3 as const;
export type ProductTutorialPolicy = 'navigation' | 'workspace' | 'connected' | 'help' | 'voice';
export interface ProductTutorialLesson { id: string; title: string; introduction: string; help: string }
export interface ProductTutorialTarget { id: string; module: string; route: string; teaches: string; policy: ProductTutorialPolicy }
/** Video chapters reuse the account guide's destinations and learning scope.
 * Playback is advisory; only the domain lesson can verify completed work. */
export interface ProductTutorialChapter {
  id: string; title: string; lessonId: string; destination: string; prompt: string | null;
}
export const PRODUCT_TUTORIAL_CHAPTERS: readonly ProductTutorialChapter[] = [
  { id: 'meet-papercup', title: 'Meet PaperCup', lessonId: 'welcome', destination: '/?app=workspaces', prompt: null },
  { id: 'create-project', title: 'Create one useful project', lessonId: 'cloud-first-agent', destination: '/?app=home&chatPane=true', prompt: 'Create a project called Workshop Planner in this cloud workspace.\n\nI want a small browser app for organizing workshop tasks. Let me add a task with a title, owner and due date, mark it complete, and keep the tasks after a page reload.\n\nKeep the data in the browser. Start from an available maintained Papercusp web-app template. Show me the template choice and plan before implementation. Keep the app private for this tutorial.' },
  { id: 'follow-work', title: 'Follow Plans, HUD and Work', lessonId: 'work', destination: '/?app=plans', prompt: null },
  { id: 'inspect-preview', title: 'Inspect the first version', lessonId: 'work', destination: '/?app=work', prompt: null },
  { id: 'grade-project', title: 'Create a rubric and grade', lessonId: 'operations', destination: '/?app=home&chatPane=true', prompt: 'Create a reusable Workshop Planner rubric from this project’s requirements.\n\nCover adding tasks, owners and due dates, completion, persistence after reload, understandable empty/error states, and keyboard usability.\n\nBind repeatable checks where possible and say what still needs human review. Enter grade mode and grade the current app against this rubric. Show the resulting scorecard and evidence. Keep this grade pass to assessment; leave implementation of findings for our next approved step.' },
  { id: 'read-scorecard', title: 'Read the scorecard', lessonId: 'operations', destination: '/?app=evals', prompt: null },
  { id: 'git-sync', title: 'Follow a change into Git', lessonId: 'operations', destination: '/?app=git', prompt: null },
  { id: 'project-knowledge', title: 'Inspect project knowledge', lessonId: 'knowledge', destination: '/?app=docs', prompt: 'Retain the verified project decisions as project memories. Document the tested procedure for running this project’s checks and verifying task persistence. Link the procedure to the code and evidence it describes.' },
  { id: 'connect-psu', title: 'Connect psu to the same cloud', lessonId: 'cloud-first-agent', destination: '/?app=cloud', prompt: 'Continue Workshop Planner in this cloud workspace. Read the current plan and work-item state. Propose the next steps for the remaining rubric findings, plus owner/status filters and a CSV export of the visible tasks. Show the proposed work before starting it.' },
  { id: 'visible-fleet', title: 'Continue with a visible fleet', lessonId: 'work', destination: '/?app=desktops', prompt: 'Approve this continuation. Lead a visible desktop fleet on this same cloud instance and project. Split genuinely independent work into separate lanes, choose the member count to fit the plan, and use the available model/account choices we review. Verify the changes and report the results. Keep the app private.' },
  { id: 'automatic-context', title: 'See context arrive during work', lessonId: 'knowledge', destination: '/?app=hud', prompt: null },
  { id: 'verify-return', title: 'Verify and return later', lessonId: 'operations', destination: '/?app=evals', prompt: 'Grade the updated Workshop Planner against the same rubric. Compare the new scorecard with the previous one, show the evidence for the changes, and tell me what still needs work.' },
];
export interface ProductTutorialVideoMedia {
  id: string; src: string; captionsSrc: string; transcriptHref: string;
  /** Measured offsets from the delivered artifact, never script estimates. */
  chapters: readonly { id: string; startSeconds: number; transcript: string }[];
}
export interface ProductTutorialVideoPosition { mediaId: string; chapterId: string; positionSeconds: number }
export const productTutorialChapterIds = new Set(PRODUCT_TUTORIAL_CHAPTERS.map(chapter => chapter.id));
export const PRODUCT_TUTORIAL_LESSONS: readonly ProductTutorialLesson[] = [
  {
    "id": "welcome",
    "title": "Welcome to Papercusp",
    "introduction": "Use Papercusp to plan work, work with agents, and inspect their results. This guide explains the product before you choose a workspace. You can pause or skip at any time.",
    "help": "Reading a lesson needs no payment, provider account, AI or microphone. A reviewed explanation records learning progress; it never proves that a task was completed."
  },
  {
    "id": "navigation",
    "title": "Find your way around",
    "introduction": "Home shows your current context. The app rail and launcher open registered destinations; More holds apps you have not pinned. Search shows its measured coverage, which can be partial.",
    "help": "Choose Open beside a destination to navigate there. Navigation does not provision resources, run a workflow, submit a task or send a message. Loading and unavailable states are not empty results."
  },
  {
    "id": "workspace",
    "title": "Choose the right workspace",
    "introduction": "Your account belongs to an organization. A workspace supplies the scope for agents, plans and project data. Choose an existing authorized workspace before using workspace tools.",
    "help": "No workspace yet? You can finish this guide now and choose one later. Creating or connecting cloud resources is an explicit action with a cost review; this guide never does it for you."
  },
  {
    "id": "planning",
    "title": "Turn a goal into reviewed work",
    "introduction": "Plans record scope, steps, decisions, dependencies and acceptance. Inbox holds questions and approvals. Workflows and schedules make execution reusable and deliberate.",
    "help": "A proposal is not an approval. Read what will run, who owns it, dependencies and cost before authorizing execution. A saved schedule must be armed to run."
  },
  {
    "id": "work",
    "title": "Work with agents and inspect results",
    "introduction": "Work shows assignments and blockers. Agent and process views show who is active; Conversations and session history retain the discussion. Papercup chat accepts your goal, context and desired output.",
    "help": "Presence is not completion. Read the task result and its evidence, ask for corrections, and verify the scope. Starting an agent or submitting a task is a separate explicit action."
  },
  {
    "id": "knowledge",
    "title": "Use what the project already knows",
    "introduction": "Docs, Insights and Learning provide source-backed project context and retained lessons. They help you understand existing behavior before requesting changes.",
    "help": "A historical note can be stale. Check its source and date, and use the current workspace context. Do not paste credentials or private project content into public support."
  },
  {
    "id": "communications",
    "title": "Connect communications deliberately",
    "introduction": "Mail, Calendar and Phone use their configured authorized integrations. You can inspect availability before connecting an account or taking an action.",
    "help": "Disconnected? Use the app's connection guidance. Sending mail, changing an event and placing a call are separate explicit actions and may have provider charges."
  },
  {
    "id": "operations",
    "title": "Read health and delivery evidence",
    "introduction": "Health, Git, Testing, PRs, History, Stats and Evals show different evidence. Read a result's source, date, scope and unknown states before relying on it.",
    "help": "History describes what happened; current state describes now. A passing test covers its named checks. It does not by itself prove a release shipped. Advanced controls still require their normal permissions."
  },
  {
    "id": "account",
    "title": "Manage your account and preferences",
    "introduction": "The account menu shows identity and organization, session status, theme and layout controls. Settings and provider accounts hold their respective configuration.",
    "help": "Keep provider credentials out of lesson questions and public support. Changing a preference does not grant permission. Sign-out ends account access; workspace permissions remain enforced independently."
  },
  {
    "id": "billing",
    "title": "Understand the bills",
    "introduction": "Billing shows your organization's Papercusp plan, subscription status and renewal or cancellation date. Plan cards describe the configured offers; review the price, currency and payment terms in Stripe before confirming any purchase. If Billing says Test mode — no real charges, its subscriptions are sandbox tests and do not provision cloud resources.",
    "help": "Papercusp subscription, model/provider usage, and cloud-resource charges are separate responsibilities. For Papercusp cloud, review the current offer and resource cost review; do not assume a subscription includes compute or model usage. With bring your own cloud (BYOC), your cloud provider bills your resources. Google Cloud bills for provisioned resources, including retained disks, which can keep charging after a session ends. A selected account or model is not proof Papercusp pays that provider bill. Check provider billing for its usage and spend; Billing's subscription status is not a total across providers. Open Billing for the current plan, status and available per-payment receipts. Only organization owners and billing admins can change billing. Use Manage billing to review plan changes, payment methods, invoices or cancellation in Stripe; read the renewal or cancellation effective date before confirming. If a payment fails, Billing explains the failure and directs you to update the payment method. If checkout is awaiting confirmation, check the subscription status before trying again. If billing or receipts are unavailable, follow the visible recovery guidance or contact Support; unavailable is not free. This guide never invents prices, quotas, free allowances or discounts, and never starts checkout or cancellation."
  },
  {
    "id": "cloud-first-agent",
    "title": "Do useful work with your first agent",
    "introduction": "After selecting a workspace, open Cloud for the maintained first-agent lesson. Review the prepared workspace and current model/account defaults, costs, and permissions before launching.",
    "help": "Submit a small bounded task with context and an output. Inspect the correlated result, request a revision, and try an independent task. Task completion is based on authorized workspace observations; marking this explanation reviewed cannot complete those steps."
  },
  {
    "id": "help",
    "title": "Get help in context",
    "introduction": "Each lesson's Help explains what its controls mean and how to recover when access or data is unavailable. Support and public Docs are fallback destinations.",
    "help": "Text Help remains usable without a microphone. Spoken lesson questions require a separate explicit gesture and microphone consent, with Stop and Cancel controls. Never include secrets or private workspace content in a lesson question."
  }
];
export const PRODUCT_TUTORIAL_TARGETS: readonly ProductTutorialTarget[] = [
  {
    "id": "home",
    "module": "navigation",
    "route": "/?app=home",
    "teaches": "Read Mission Control and distinguish empty, loading and unavailable data.",
    "policy": "navigation"
  },
  {
    "id": "mail",
    "module": "communications",
    "route": "/?app=mail",
    "teaches": "Read authorized mail; sending is a separate explicit action.",
    "policy": "connected"
  },
  {
    "id": "calendar",
    "module": "communications",
    "route": "/?app=calendar",
    "teaches": "Review authorized events; changes require explicit confirmation in the app.",
    "policy": "connected"
  },
  {
    "id": "phone",
    "module": "communications",
    "route": "/?app=phone",
    "teaches": "Find phone controls; calls are explicit and may incur provider charges.",
    "policy": "connected"
  },
  {
    "id": "desktops",
    "module": "workspace",
    "route": "/?app=desktops",
    "teaches": "Open an authorized prepared workspace desktop and review its readiness.",
    "policy": "workspace"
  },
  {
    "id": "plans",
    "module": "planning",
    "route": "/?app=plans",
    "teaches": "Read plan scope, steps, decisions, dependencies and acceptance.",
    "policy": "workspace"
  },
  {
    "id": "inbox",
    "module": "planning",
    "route": "/?app=inbox",
    "teaches": "Review questions and approvals before choosing an answer.",
    "policy": "workspace"
  },
  {
    "id": "workspaces",
    "module": "workspace",
    "route": "/?app=workspaces",
    "teaches": "Select an existing workspace or explicitly review a new connection/provisioning request.",
    "policy": "workspace"
  },
  {
    "id": "overview",
    "module": "work",
    "route": "/?app=overview",
    "teaches": "Read workspace overview and current scope.",
    "policy": "workspace"
  },
  {
    "id": "hud",
    "module": "work",
    "route": "/?app=hud",
    "teaches": "Read agent status, activity and evidence without inferring completion from presence.",
    "policy": "workspace"
  },
  {
    "id": "work",
    "module": "work",
    "route": "/?app=work",
    "teaches": "Find pots and work items, assignments and blocked work.",
    "policy": "workspace"
  },
  {
    "id": "learning",
    "module": "knowledge",
    "route": "/?app=learning",
    "teaches": "Review retained lessons for the selected pot.",
    "policy": "workspace"
  },
  {
    "id": "workflows",
    "module": "planning",
    "route": "/?app=workflows",
    "teaches": "Inspect workflow structure before explicitly running it.",
    "policy": "workspace"
  },
  {
    "id": "enterprise",
    "module": "planning",
    "route": "/?app=enterprise",
    "teaches": "Find the runnable enterprise operations in the shared workflow inventory before explicitly running one.",
    "policy": "workspace"
  },
  {
    "id": "brainstorm",
    "module": "planning",
    "route": "/?app=brainstorm",
    "teaches": "Explore proposals without mistaking suggestions for approved work.",
    "policy": "workspace"
  },
  {
    "id": "health",
    "module": "operations",
    "route": "/?app=health",
    "teaches": "Read health evidence and distinguish unknown from healthy.",
    "policy": "workspace"
  },
  {
    "id": "prs",
    "module": "operations",
    "route": "/?app=prs",
    "teaches": "Review pull requests; merging or publishing remains an explicit product action.",
    "policy": "workspace"
  },
  {
    "id": "insights",
    "module": "knowledge",
    "route": "/?app=insights",
    "teaches": "Read source-backed insights for the selected pot.",
    "policy": "workspace"
  },
  {
    "id": "conversations",
    "module": "work",
    "route": "/?app=conversations",
    "teaches": "Find durable discussions and their work context.",
    "policy": "workspace"
  },
  {
    "id": "adv-settings",
    "module": "account",
    "route": "/?app=adv-settings",
    "teaches": "Inspect pot settings; changes need appropriate permissions.",
    "policy": "workspace"
  },
  {
    "id": "docs",
    "module": "knowledge",
    "route": "/?app=docs",
    "teaches": "Read project documentation with the selected pot context.",
    "policy": "workspace"
  },
  {
    "id": "history",
    "module": "operations",
    "route": "/?app=history",
    "teaches": "Read historical events; history and current state answer different questions.",
    "policy": "workspace"
  },
  {
    "id": "git",
    "module": "operations",
    "route": "/?app=git",
    "teaches": "Inspect source and pipeline evidence before relying on a release.",
    "policy": "workspace"
  },
  {
    "id": "stats",
    "module": "operations",
    "route": "/?app=stats",
    "teaches": "Read measured usage/activity and the scope of each metric.",
    "policy": "workspace"
  },
  {
    "id": "testing",
    "module": "operations",
    "route": "/?app=testing",
    "teaches": "Find test results and their exact source and coverage.",
    "policy": "workspace"
  },
  {
    "id": "create",
    "module": "planning",
    "route": "/?app=create",
    "teaches": "Prepare a proposal in the Create dock before approving implementation.",
    "policy": "workspace"
  },
  {
    "id": "scheduled",
    "module": "planning",
    "route": "/?app=scheduled",
    "teaches": "Read scheduled plans, recurrence and whether a schedule is armed.",
    "policy": "workspace"
  },
  {
    "id": "frames",
    "module": "work",
    "route": "/?app=frames",
    "teaches": "Inspect the selected pot's frames and their scope.",
    "policy": "workspace"
  },
  {
    "id": "evals",
    "module": "operations",
    "route": "/?app=evals",
    "teaches": "Read evaluation criteria, evidence and unknown results.",
    "policy": "workspace"
  },
  {
    "id": "coord",
    "module": "work",
    "route": "/?app=coord",
    "teaches": "Read agent coordination, ownership and handoffs.",
    "policy": "workspace"
  },
  {
    "id": "cloud",
    "module": "cloud-first-agent",
    "route": "/?app=cloud",
    "teaches": "Use the existing correlated first-agent lesson, including cost review, explicit launch, result inspection and independent practice.",
    "policy": "workspace"
  },
  {
    "id": "cupboard",
    "module": "planning",
    "route": "/?app=cupboard",
    "teaches": "Browse maintained apps/templates before explicitly installing anything.",
    "policy": "workspace"
  },
  {
    "id": "dev",
    "module": "operations",
    "route": "/?app=dev",
    "teaches": "Find developer tools; advanced actions remain permission-bound.",
    "policy": "workspace"
  },
  {
    "id": "support",
    "module": "help",
    "route": "/?app=support",
    "teaches": "Find FAQ and support chat for a concrete question.",
    "policy": "help"
  },
  {
    "id": "settings",
    "module": "account",
    "route": "/?app=settings",
    "teaches": "Review product preferences and settings before changing them.",
    "policy": "navigation"
  },
  {
    "id": "launcher",
    "module": "navigation",
    "route": "/?panel=launcher",
    "teaches": "Find registered apps, including destinations in More.",
    "policy": "navigation"
  },
  {
    "id": "more",
    "module": "navigation",
    "route": "/?panel=more",
    "teaches": "Find unpinned destinations; pinning is a preference, not permission.",
    "policy": "navigation"
  },
  {
    "id": "notifications",
    "module": "navigation",
    "route": "/?panel=notifications",
    "teaches": "Inspect notifications and unread/unknown status.",
    "policy": "navigation"
  },
  {
    "id": "account",
    "module": "account",
    "route": "/?panel=account",
    "teaches": "Review identity, organization, session status and sign-out.",
    "policy": "navigation"
  },
  {
    "id": "agents",
    "module": "work",
    "route": "/?panel=agents",
    "teaches": "Inspect the authorized agent roster; launching remains explicit.",
    "policy": "workspace"
  },
  {
    "id": "processes",
    "module": "work",
    "route": "/?panel=processes",
    "teaches": "Inspect running task/process evidence and its freshness.",
    "policy": "workspace"
  },
  {
    "id": "sessions",
    "module": "work",
    "route": "/?panel=sessions",
    "teaches": "Read session history and reopen the intended conversation.",
    "policy": "workspace"
  },
  {
    "id": "voice",
    "module": "help",
    "route": "/settings/voice",
    "teaches": "Choose a configured chat voice engine; tutorial recording has separate consent.",
    "policy": "voice"
  },
  {
    "id": "quick",
    "module": "navigation",
    "route": "/?panel=quick",
    "teaches": "Use the quick palette for prompts, brainstorm and docs.",
    "policy": "navigation"
  },
  {
    "id": "accounts-dock",
    "module": "account",
    "route": "/?accountsPane=true",
    "teaches": "Review model/provider accounts; keep credentials out of lesson Help.",
    "policy": "workspace"
  },
  {
    "id": "papercup-chat",
    "module": "work",
    "route": "/?chatPane=true",
    "teaches": "Give a goal, context and output; verify answers and request corrections.",
    "policy": "workspace"
  },
  {
    "id": "billing",
    "module": "billing",
    "route": "/billing",
    "teaches": "Read current organization subscription and receipts; checkout, management and cancellation require billing permission and explicit action.",
    "policy": "navigation"
  },
  {
    "id": "search",
    "module": "navigation",
    "route": "/?q=plans",
    "teaches": "Search loaded content and inspect partial/unknown search coverage.",
    "policy": "navigation"
  },
  {
    "id": "theme-layout",
    "module": "account",
    "route": "/?panel=account",
    "teaches": "Choose theme/layout preferences and learn which settings persist across devices.",
    "policy": "navigation"
  },
  {
    "id": "spoken-questions",
    "module": "help",
    "route": "tutorial:explicit-question-control",
    "teaches": "Ask an optional spoken lesson question only after microphone consent; retain text Help and stop/cancel controls.",
    "policy": "voice"
  }
];
export const productTutorialLessonIds = new Set(PRODUCT_TUTORIAL_LESSONS.map(lesson => lesson.id));
export function productTutorialTargetAvailability(target: ProductTutorialTarget, workspaceId: string | null): string | null {
  if (target.route.startsWith('tutorial:')) return 'Spoken questions use the guide’s separate consent control.';
  if (target.policy === 'workspace' && !workspaceId) return 'Choose an authorized workspace to open this destination. You can continue learning now.';
  return null;
}
