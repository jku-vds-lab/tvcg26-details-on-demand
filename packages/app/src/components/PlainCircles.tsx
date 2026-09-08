import { AnimatePresence, motion } from 'framer-motion'

// Define a generic data shape for circles
export interface CircleData {
  id: string              // stable identifier for React keying
  x: number               // x-coordinate in px
  y: number               // y-coordinate in px
  radius: number          // diameter or radius in px
  color: string           // CSS color string
}

interface PlainCirclesProps {
  circles: CircleData[]
}

/**
 * Purely renders circles based on passed-in data;
 * no Framer Motion hooks or props.
 */
export const PlainCircles = ({ circles }: PlainCirclesProps) => (
  <div className="circles-container">
    {circles.map(circle => (
      <div
        key={circle.id}
        className="circle"
        style={{
          position: 'absolute',
          top: circle.y,
          left: circle.x,
          width: circle.radius,
          height: circle.radius,
          borderRadius: '50%',
          backgroundColor: circle.color,
        }}
      />
    ))}
  </div>
)

interface AnimatedCirclesProps {
  circles: CircleData[]
}

/**
 * Wraps PlainCircles items with Framer Motion for automatic layout
 * and presence animations via "layout" and AnimatePresence.
 */
export const AnimatedCircles = ({ circles }: AnimatedCirclesProps) => (
  <div className="circles-container">
    <AnimatePresence>
      {circles.map(circle => (
        <motion.div
          key={circle.id}
          layout
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 0 }}
          style={{
            position: 'absolute',
            top: circle.y,
            left: circle.x,
            width: circle.radius,
            height: circle.radius,
            borderRadius: '50%',
            backgroundColor: circle.color,
          }}
        />
      ))}
    </AnimatePresence>
  </div>
)
