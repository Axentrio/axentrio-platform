/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class', 'class'],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
  	container: {
  		center: true,
  		padding: '2rem',
  		screens: {
  			'2xl': '1400px'
  		}
  	},
  	extend: {
  		fontFamily: {
  			sans: [
  				'Plus Jakarta Sans"',
  				'system-ui',
  				'sans-serif'
  			],
  			mono: [
  				'JetBrains Mono"',
  				'monospace'
  			],
  			display: [
  				'Plus Jakarta Sans"',
  				'system-ui',
  				'sans-serif'
  			]
  		},
  		colors: {
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			primary: {
  				'50': 'rgb(var(--color-primary-50, 238 242 255) / <alpha-value>)',
  				'100': 'rgb(var(--color-primary-100, 224 231 255) / <alpha-value>)',
  				'200': 'rgb(var(--color-primary-200, 199 210 254) / <alpha-value>)',
  				'300': 'rgb(var(--color-primary-300, 165 180 252) / <alpha-value>)',
  				'400': 'rgb(var(--color-primary-400, 129 140 248) / <alpha-value>)',
  				'500': 'rgb(var(--color-primary-500, 99 102 241) / <alpha-value>)',
  				'600': 'rgb(var(--color-primary-600, 79 70 229) / <alpha-value>)',
  				'700': 'rgb(var(--color-primary-700, 67 56 202) / <alpha-value>)',
  				'800': 'rgb(var(--color-primary-800, 55 48 163) / <alpha-value>)',
  				'900': 'rgb(var(--color-primary-900, 49 46 129) / <alpha-value>)',
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				'50': '#fffbeb',
  				'100': '#fef3c7',
  				'200': '#fde68a',
  				'300': '#fcd34d',
  				'400': '#fbbf24',
  				'500': '#f59e0b',
  				'600': '#d97706',
  				'700': '#b45309',
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			surface: {
  				'0': 'rgb(var(--color-surface-0) / <alpha-value>)',
  				'1': 'rgb(var(--color-surface-1) / <alpha-value>)',
  				'2': 'rgb(var(--color-surface-2) / <alpha-value>)',
  				'3': 'rgb(var(--color-surface-3) / <alpha-value>)',
  				'4': 'rgb(var(--color-surface-4) / <alpha-value>)'
  			},
  			edge: {
  				DEFAULT: 'rgb(var(--color-edge) / <alpha-value>)',
  				light: 'rgb(var(--color-edge-light, 53 56 80) / <alpha-value>)',
  				focus: 'rgb(var(--color-primary-600, 79 70 229) / <alpha-value>)'
  			},
  			text: {
  				primary: 'rgb(var(--color-text-primary) / <alpha-value>)',
  				secondary: 'rgb(var(--color-text-secondary) / <alpha-value>)',
  				muted: 'rgb(var(--color-text-muted, 107 113 148) / <alpha-value>)',
  				inverse: 'rgb(var(--color-text-inverse, 15 17 23) / <alpha-value>)'
  			},
  			status: {
  				online: '#34d399',
  				away: '#fbbf24',
  				offline: '#6b7194',
  				busy: '#f87171'
  			},
  			chat: {
  				bot: '#a78bfa',
  				human: '#34d399',
  				handsoff: '#fbbf24',
  				closed: '#6b7194'
  			}
  		},
  		backgroundImage: {
  			noise: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")`
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		boxShadow: {
  			'glow-sm': '0 0 10px -3px rgba(var(--color-primary-rgb, 99, 102, 241), 0.3)',
  			glow: '0 0 20px -5px rgba(var(--color-primary-rgb, 99, 102, 241), 0.4)',
  			'glow-lg': '0 0 30px -5px rgba(var(--color-primary-rgb, 99, 102, 241), 0.5)',
  			card: '0 4px 24px -4px rgba(0, 0, 0, 0.3)',
  			'card-hover': '0 8px 32px -4px rgba(0, 0, 0, 0.5)'
  		},
  		keyframes: {
  			'bounce-slight': {
  				'0%, 100%': {
  					transform: 'translateY(0)'
  				},
  				'50%': {
  					transform: 'translateY(-4px)'
  				}
  			},
  			slideIn: {
  				from: {
  					opacity: '0',
  					transform: 'translateX(20px)'
  				},
  				to: {
  					opacity: '1',
  					transform: 'translateX(0)'
  				}
  			},
  			fadeIn: {
  				from: {
  					opacity: '0',
  					transform: 'scale(0.95)'
  				},
  				to: {
  					opacity: '1',
  					transform: 'scale(1)'
  				}
  			},
  			fadeInUp: {
  				from: {
  					opacity: '0',
  					transform: 'translateY(12px)'
  				},
  				to: {
  					opacity: '1',
  					transform: 'translateY(0)'
  				}
  			},
  			glowPulse: {
  				'0%, 100%': {
  					boxShadow: '0 0 8px rgba(var(--color-primary-rgb, 99, 102, 241), 0.3)'
  				},
  				'50%': {
  					boxShadow: '0 0 20px rgba(var(--color-primary-rgb, 99, 102, 241), 0.6)'
  				}
  			},
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			},
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'pulse-slow': 'pulse 3s ease-in-out infinite',
  			'bounce-slight': 'bounce-slight 0.6s ease-in-out',
  			'slide-in': 'slideIn 0.3s ease-out',
  			'fade-in': 'fadeIn 0.4s ease-out',
  			'fade-in-up': 'fadeInUp 0.5s ease-out',
  			'glow-pulse': 'glowPulse 2s ease-in-out infinite',
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out',
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
};
