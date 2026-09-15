import {useEffect, useState} from 'react'
import {repeat} from '../services/clock'
import {MINUTE_MS} from '../utils/relative-time'

/** The clock, as fine as a relative time label reads it. */
export function useNow(): number {
    const [now, setNow] = useState(Date.now)
    useEffect(
        () =>
            repeat(() => {
                setNow(Date.now())
            }, MINUTE_MS),
        []
    )
    return now
}
