declare module '*?worker&inline' {
  const WorkerConstructor: { new (options?: { name?: string }): Worker };
  export default WorkerConstructor;
}
