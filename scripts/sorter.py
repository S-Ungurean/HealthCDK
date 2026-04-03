import json
import os
import boto3
from botocore.config import Config

SOURCE_BUCKET = 'aegiscaninputs'

def handler(event, context):
    # Event is the direct payload (not API Gateway-wrapped).
    # Expecting: { "sourceKey": "uuid_file.png", "species": "human"|"animal",
    #              "imageType": "...", "anatomy": "...", "plane": "..." }
    s3_config = Config(signature_version='s3v4')
    s3_client = boto3.client('s3', config=s3_config)

    try:
        source_key = event.get('sourceKey')
        species = event.get('species', 'human').lower()
        image_type = event.get('imageType')
        anatomy = event.get('anatomy')
        plane = event.get('plane')

        if not source_key:
            return {'statusCode': 400, 'body': json.dumps({'error': 'Missing sourceKey'})}

        # Determine target bucket
        if species == 'human':
            target_bucket = os.environ['HUMAN_BUCKET_NAME']
        else:
            target_bucket = os.environ['ANIMAL_BUCKET_NAME']

        # Build destination key — quarantine if not a recognisable medical image
        if not image_type or image_type == "null":
            dest_key = f"quarantine/{source_key}"
        else:
            path_parts = [image_type, anatomy, plane]
            valid_parts = [str(p) for p in path_parts if p and p != "null"]
            dest_key = "/".join(valid_parts) + f"/{source_key}"

        # Copy from aegiscaninputs to the categorised bucket
        s3_client.copy_object(
            CopySource={'Bucket': SOURCE_BUCKET, 'Key': source_key},
            Bucket=target_bucket,
            Key=dest_key,
            MetadataDirective='REPLACE',
            Metadata={
                'image-type': str(image_type) if image_type else 'unknown',
                'anatomy': str(anatomy) if anatomy else 'unknown',
                'plane': str(plane) if plane else 'N/A',
            },
        )

        print(f"Copied {SOURCE_BUCKET}/{source_key} -> {target_bucket}/{dest_key}")
        return {
            'statusCode': 200,
            'body': json.dumps({'key': dest_key, 'bucket': target_bucket}),
        }

    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }