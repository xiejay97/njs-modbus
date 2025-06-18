/**
 * Get time interval between message frames witch well-known as 3.5T.
 * @param baudRate Serial port baud rate.
 * @param {number} [approximation=48] Approximate number of bits corresponding to 3.5T.
 * @returns `ms`.
 */
export function getThreePointFiveT(baudRate: number, approximation = 48) {
  return (approximation * 1000) / baudRate;
}
