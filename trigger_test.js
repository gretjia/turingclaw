async function trigger() {
  try {
    const res = await fetch('http://0.0.0.0:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'START_TEST_SUITE' })
    });
    console.log(await res.json());
  } catch (e) {
    console.error(e);
  }
}
trigger();
