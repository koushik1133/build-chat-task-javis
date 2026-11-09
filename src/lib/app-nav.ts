import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  MessageSquare,
  FileText,
  Github,
  ListTodo,
  Wand2,
  BarChart2,
  Briefcase,
  Bot,
  Zap,
  Kanban,
  Users,
  Network,
  Share2,
  Building2,
  Heart,
  GraduationCap,
  Scale,
  DollarSign,
  Home,
  ShoppingBag,
  HandHeart,
  Rocket,
  Globe,
  Lightbulb,
  Megaphone,
  CheckSquare,
  Gauge,
  KeyRound,
  ScrollText,
  Inbox,
  CalendarDays,
  Receipt,
  Package,
  Wallet,
  PieChart,
  LifeBuoy,
  BookOpen,
  Palette,
  Upload,
  BellRing,
  TrendingUp,
  Store,
  PhoneOutgoing,
  Webhook,
  Code2,
  Mail,
  ShieldCheck,
  Landmark,
  Fingerprint,
  Activity,
  LayoutDashboard,
  MessageSquareCode,
  Truck,
  CalendarClock,
  FileSignature,
  FolderKanban,
  ShoppingCart,
  Send,
  MessageCircle,
  DatabaseBackup,
} from "lucide-react";

export type AppNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group?: string;
};

export const APP_NAV_TOP: AppNavItem[] = [
  { href: "/home", label: "Home", icon: LayoutDashboard },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/files", label: "Files", icon: FileText },
  { href: "/github", label: "GitHub", icon: Github },
];

/** A titled block of nav links. Groups render in array order. */
export type AppNavGroup = {
  /** Heading shown above the block. */
  title: string;
  items: AppNavItem[];
};

/**
 * The sidebar's static groups, in render order.
 *
 * The CHANNELS group is NOT here — it is built at runtime from the signed-in
 * user's connected accounts (see src/lib/nav/channel-nav.ts) and injected by
 * the sidebar, so it grows as channels are connected.
 */
export const NAV_GROUPS: AppNavGroup[] = [
  {
    title: "Create & Publish",
    items: [
      { href: "/social", label: "Social Media", icon: Share2 },
      { href: "/build", label: "AI Studio", icon: Wand2 },
    ],
  },
  {
    title: "Engage",
    items: [
      { href: "/messaging", label: "Messages", icon: MessageSquare },
      { href: "/leads", label: "Lead Inbox", icon: Users },
      { href: "/crm", label: "CRM", icon: Globe },
      { href: "/calendar", label: "Calendar", icon: CalendarDays },
      { href: "/helpdesk", label: "Helpdesk", icon: LifeBuoy },
      { href: "/knowledge", label: "Knowledge Base", icon: BookOpen },
      { href: "/documents", label: "Documents", icon: FileSignature },
      { href: "/marketing", label: "Marketing", icon: Send },
    ],
  },
  {
    title: "Grow",
    items: [
      { href: "/ads", label: "Ads · Meta + Google", icon: Megaphone },
      { href: "/analytics", label: "Data Analysis", icon: BarChart2 },
      { href: "/strategy", label: "Strategy Hub", icon: Briefcase },
    ],
  },
  {
    title: "Operate",
    items: [
      { href: "/agency", label: "Agency Command", icon: Building2 },
      { href: "/agency/clients", label: "Client Workspaces", icon: Building2 },
      { href: "/production", label: "Production", icon: Kanban },
      { href: "/tasks", label: "Tasks", icon: ListTodo },
      { href: "/billing", label: "Billing", icon: Receipt },
      { href: "/inventory", label: "Inventory", icon: Package },
      { href: "/procurement", label: "Procurement", icon: Truck },
      { href: "/workforce", label: "Workforce", icon: CalendarClock },
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/orders", label: "Orders & storefront", icon: ShoppingCart },
      { href: "/finance", label: "Finance", icon: Wallet },
      { href: "/reports", label: "Reports", icon: PieChart },
      { href: "/insights", label: "Insights", icon: TrendingUp },
    ],
  },
  {
    title: "Automate",
    items: [
      { href: "/agents", label: "AI Agents", icon: Bot },
      { href: "/agents/swarms", label: "Agent Swarms", icon: Network },
      { href: "/automations", label: "Automations", icon: Zap },
      { href: "/marketplace", label: "Marketplace", icon: Store },
      { href: "/voice", label: "Voice Campaigns", icon: PhoneOutgoing },
      { href: "/approvals", label: "Approvals", icon: CheckSquare },
      { href: "/settings/ai", label: "AI Settings", icon: Gauge },
      { href: "/settings/team", label: "Team", icon: Users },
      { href: "/settings/audit", label: "Audit Log", icon: ScrollText },
      { href: "/settings/outbox", label: "Outbox", icon: Inbox },
      { href: "/settings/api-keys", label: "API Keys", icon: KeyRound },
      { href: "/settings/webhooks", label: "Webhooks", icon: Webhook },
      { href: "/settings/calendar-sync", label: "Calendar sync", icon: CalendarClock },
      { href: "/settings/chat-apps", label: "Chat apps", icon: MessageCircle },
      { href: "/settings/snapshots", label: "Snapshots & backup", icon: DatabaseBackup },
      { href: "/settings/widgets", label: "Website widgets", icon: MessageSquareCode },
      { href: "/settings/developers", label: "Developers", icon: Code2 },
      { href: "/settings/mail", label: "Email Inbox", icon: Mail },
      { href: "/settings/sso", label: "SSO & SCIM", icon: ShieldCheck },
      { href: "/settings/accounting", label: "Accounting", icon: Landmark },
      { href: "/settings/privacy", label: "Privacy & data", icon: Fingerprint },
      { href: "/settings/system", label: "System health", icon: Activity },
      { href: "/settings/branding", label: "Branding", icon: Palette },
      { href: "/settings/import", label: "Import & Export", icon: Upload },
      { href: "/settings/notifications", label: "Notifications", icon: BellRing },
    ],
  },
  {
    title: "Domain Hubs",
    items: [
      { href: "/r", label: "Records", icon: Boxes },
      { href: "/domains/healthcare", label: "Healthcare Hub", icon: Heart },
      { href: "/domains/education", label: "Education Hub", icon: GraduationCap },
      { href: "/domains/legal", label: "Legal Hub", icon: Scale },
      { href: "/domains/finance", label: "Finance Hub", icon: DollarSign },
      { href: "/domains/realestate", label: "Real Estate Hub", icon: Home },
      { href: "/domains/ecommerce", label: "E-commerce Hub", icon: ShoppingBag },
      { href: "/domains/nonprofit", label: "Non-profit Hub", icon: HandHeart },
      { href: "/domains/business", label: "Startup Hub", icon: Rocket },
      { href: "/domains/request", label: "Request Domain", icon: Lightbulb },
    ],
  },
];

export const APP_NAV: AppNavItem[] = [
  ...APP_NAV_TOP,
  ...NAV_GROUPS.flatMap((g) => g.items),
];
