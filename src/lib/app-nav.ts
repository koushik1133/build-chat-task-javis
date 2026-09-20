import type { LucideIcon } from "lucide-react";
import {
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
} from "lucide-react";

export type AppNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group?: string;
};

export const APP_NAV_TOP: AppNavItem[] = [
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
      { href: "/production", label: "Production", icon: Kanban },
      { href: "/tasks", label: "Tasks", icon: ListTodo },
    ],
  },
  {
    title: "Automate",
    items: [
      { href: "/agents", label: "AI Agents", icon: Bot },
      { href: "/agents/swarms", label: "Agent Swarms", icon: Network },
      { href: "/automations", label: "Automations", icon: Zap },
    ],
  },
  {
    title: "Domain Hubs",
    items: [
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
