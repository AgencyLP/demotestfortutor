exports.handler = async function (event) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: "Segment function placeholder only. No chunking yet.",
      step: "segmentation",
      ready: false
    })
  };
};
