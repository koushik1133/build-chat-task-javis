import re

with open('src/lib/build-categories.ts', 'r') as f:
    content = f.read()

def replace_theme(match):
    full_match = match.group(0)
    swatch_line = match.group(1)
    # Check if colors already exists
    if "colors:" in full_match:
        return full_match
    
    # Extract colors from swatch
    # e.g., from-emerald-600 to-teal-700
    # Map them to hex
    color_map = {
        'emerald-600': '#059669',
        'teal-700': '#0f766e',
        'orange-500': '#f97316',
        'red-600': '#dc2626',
        'amber-400': '#fbbf24',
        'rose-500': '#f43f5e',
        'slate-600': '#475569',
        'slate-700': '#334155',
        'slate-900': '#0f172a',
        'fuchsia-500': '#d946ef',
        'pink-600': '#db2777',
        'stone-300': '#d6d3d1',
        'stone-700': '#44403c',
        'yellow-400': '#facc15',
        'stone-500': '#78716c',
        'emerald-700': '#047857',
        'indigo-500': '#6366f1',
        'violet-700': '#6d28d9',
        'blue-500': '#3b82f6',
        'violet-500': '#8b5cf6',
        'pink-500': '#ec4899',
        'zinc-100': '#f4f4f5',
        'zinc-500': '#71717a',
        'zinc-700': '#3f3f46',
        'zinc-900': '#18181b',
        'amber-200': '#fde68a',
        'stone-600': '#57534e',
        'white': '#ffffff',
        'zinc-300': '#d4d4d8',
        'black': '#000000',
        'lime-400': '#a3e635',
        'blue-600': '#2563eb',
        'indigo-700': '#4338ca',
        'rose-200': '#fecdd3',
        'orange-400': '#fb923c',
        'yellow-300': '#fde047',
        'teal-300': '#5eead4',
        'sky-500': '#0ea5e9',
        'blue-700': '#1d4ed8',
        'pink-400': '#f472b6',
        'purple-500': '#a855f7'
    }

    swatch_match = re.search(r'from-([a-z0-9-]+)(?: via-([a-z0-9-]+))? to-([a-z0-9-]+)', swatch_line)
    if not swatch_match:
        return full_match
    
    c1 = color_map.get(swatch_match.group(1), '#000000')
    c2 = color_map.get(swatch_match.group(2)) if swatch_match.group(2) else None
    c3 = color_map.get(swatch_match.group(3), '#ffffff')

    if c2:
        colors = f'colors: ["{c1}", "{c2}", "{c3}"],'
    else:
        colors = f'colors: ["{c1}", "{c3}", "#ffffff"],'
    
    return full_match.replace(swatch_line, f'{swatch_line}\n        {colors}')

# Replace themes
new_content = re.sub(r'{\s*id: "[^"]+",\s*label: "[^"]+",\s*brief:[\s\S]*?swatch: "[^"]+",?\n\s*}', replace_theme, content)

with open('src/lib/build-categories.ts', 'w') as f:
    f.write(new_content)
print("Done")
